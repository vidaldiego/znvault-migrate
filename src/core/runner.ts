import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { EngineAdapter, Conn, SchemaMigrationsRepo } from '../adapters/engine-adapter.js';
import { discover } from './migration-files.js';
import { readBaselineMarker } from './baseline-marker.js';
import { canonicalChecksumFile } from './checksum.js';
import { plan } from './planner.js';
import type { RunResult } from './types.js';
import {
  APPROVED_FAILED_MIGRATION_CHECKSUM_REPAIRS,
  type FailedMigrationChecksumRepair,
} from './failed-checksum-repair.js';

export type { RunResult };

/**
 * Orchestrates migration discovery, planning, locking, and execution.
 *
 * Ports MigrationRunner.kt + MigrateMain.kt orchestration EXACTLY:
 *  - status(): read-only — ensureTable + plan; preflight(version-check only).
 *  - run(): write path — preflight(requireWritePrimary=true) → ensureTable (before lock,
 *    Kotlin parity) → acquire → exact failed-checksum repair → seedIfVirgin → plan →
 *    reconcile → pending → release.
 *
 * `zn_*` helper procedures (0000_ files) are NOT created by this engine — see the
 * doc comment on run() for details.
 *
 * Engine-agnostic core: the six MySQL-specific collaborators (preflight, lock
 * acquire/isHeld/release, migration-file apply, reconcile, definer-object cleanup,
 * schema_migrations repo) are delegated to an injected `EngineAdapter` operating
 * on a live `Conn`. The runner's own control flow — ordering, guards, error
 * strings — is unchanged from the MySQL-only source.
 */
export class MigrationRunner {
  private repo: SchemaMigrationsRepo;

  /**
   * @param adapter        The engine adapter — implements the six MySQL-specific
   *                       collaborators (preflight, lock, migration-file apply,
   *                       reconcile, definer-object cleanup, schema_migrations repo).
   * @param conn           The live connection the adapter's methods operate on.
   * @param migrationsDir  The CURRENT phase's migrations directory — the one whose
   *                       files are classified and applied.
   * @param appliedBy      The applied-by identity recorded on each row.
   * @param integrityDirs  Additional directories that share this DB's
   *                       schema_migrations history (the OTHER migration phase's dir,
   *                       e.g. the pre/ dir when this runner is running post/). Used
   *                       only to widen the orphan/checksum integrity lookup so a row
   *                       applied by a sibling phase is not mistaken for a
   *                       renamed/deleted file. Defaults to none (single-dir configs).
   * @param scaffolding    Optional migration-helper scaffolding config for THIS phase.
   *                       When set, `run()` applies `<migrationsDir>/<filename>` at the
   *                       start of the phase (after discover(), before seeding/reconcile/
   *                       pending) and, unconditionally, drops every object the given
   *                       `leaseUser` defined once the reconcile+pending work concludes
   *                       (success or failure) — see the ordering note on run(). Undefined
   *                       (the default) means no scaffolding: byte-identical to the
   *                       pre-scaffolding runner.
   */
  constructor(
    private readonly adapter: EngineAdapter,
    private readonly conn: Conn,
    private readonly migrationsDir: string,
    private readonly appliedBy: string,
    private readonly integrityDirs: string[] = [],
    private readonly scaffolding?: { filename: string; leaseUser: string },
    private readonly checksumRepairs: readonly FailedMigrationChecksumRepair[] = APPROVED_FAILED_MIGRATION_CHECKSUM_REPAIRS,
  ) {
    this.repo = adapter.schemaMigrationsRepo(conn);
  }

  /**
   * Build the union of migration files across this phase's dir and any sibling
   * integrity dirs (pre ∪ post), for the planner's integrity lookup. Missing dirs
   * are skipped defensively (discover() throws on a non-existent path). If two dirs
   * ever declare the same version prefix, the current phase's file wins the lookup.
   */
  private allTrackedFiles(phaseFiles: ReturnType<typeof discover>): ReturnType<typeof discover> {
    const byVersion = new Map(phaseFiles.map((f) => [f.version, f]));
    for (const dir of this.integrityDirs) {
      if (dir === this.migrationsDir || !existsSync(dir)) continue;
      for (const f of discover(dir)) {
        if (!byVersion.has(f.version)) byVersion.set(f.version, f);
      }
    }
    return [...byVersion.values()];
  }

  /**
   * Read-only status: how many migrations are in each state.
   * Does NOT acquire the lock or apply any helpers.
   * Mirrors MigrateMain: preflight(requireWritePrimary=false) for 'status'.
   */
  async status(): Promise<{ applied: number; reconcile: number; pending: number }> {
    await this.adapter.preflight(this.conn, false); // version-check only; skip read-only check
    await this.repo.ensureTable();
    const phaseFiles = discover(this.migrationsDir);
    const trackedFiles = this.allTrackedFiles(phaseFiles);
    const filesByVersion = new Map(trackedFiles.map((file) => [file.version, file]));
    const previewRows = (await this.repo.all()).map((row) => {
      const file = filesByVersion.get(row.version);
      const repair = file ? this.approvedRepairFor(row, file.path) : undefined;
      return repair ? { ...row, checksum: repair.newChecksum } : row;
    });
    const p = plan(phaseFiles, previewRows, canonicalChecksumFile, trackedFiles);
    return { applied: p.applied.length, reconcile: p.reconcile.length, pending: p.pending.length };
  }

  /**
   * Apply all pending and reconcile migrations.
   *
   * Order (load-bearing — matches Kotlin MigrationRunner.run() exactly):
   *  1. preflight(requireWritePrimary=true) — refuse read-only replicas.
   *  2. ensureTable() BEFORE the lock (the only pre-lock mutation, per Kotlin parity).
   *  3. acquire(db) — GET_LOCK.
   *  3a. scaffolding (if configured) — apply THIS phase's helper objects (migration_utils.sql
   *      or equivalent) before any seeding/reconcile/pending work touches the DB.
   *  4. repairFailedChecksums — exact allowlist + audited compare-and-swap for
   *     failed, non-baselined rows only (including sibling-phase rows).
   *  5. seedBaselineIfVirgin — seed baselined rows when schema_migrations is empty.
   *  6. plan() — classify remaining files.
   *  7. reconcile — marked postconditions first; legacy/unmet files re-run fully.
   *  8. pending — claim(success=0) → exec → markSuccess(success=1).
   *  8a. finally (nested, scoped to 7+8): scaffolding cleanup — if configured and the
   *      lock is still held, drop every object the lease user defined
   *      (dropDefinerObjects), unconditionally — runs whether 7/8 succeeded or threw.
   *      A cleanup failure is logged, never rethrown (must not mask a primary error).
   *      The lock-held check itself (lockHeld()) is also non-throwing — a dead
   *      connection can make the underlying IS_USED_LOCK query reject rather than
   *      resolve false, and this guard must not mask a primary error either.
   *  9. finally: release lock; if release was not clean and no primary error, throw tripwire.
   *
   * Discovered `0000_` files remain inert. Helper procedures are supplied explicitly
   * through the phase's scaffolding config (and cleaned up below), or provisioned by
   * Vault before the phase. Migrations only `CALL zn_*`; they do not implicitly create
   * helpers merely because a `0000_` file was discovered.
   */
  async run(): Promise<RunResult> {
    await this.adapter.preflight(this.conn, true); // refuse read-only replica

    // ensureTable BEFORE the lock — the CREATE TABLE IF NOT EXISTS is the sole
    // pre-lock mutation. This matches Kotlin to allow a fresh DB to get the table
    // without contention risk (only one runner is expected in normal operation).
    await this.repo.ensureTable();

    await this.adapter.acquireLock(this.conn);
    let primary: unknown = null;
    try {
      let phaseFailed = false;
      let rollbackConfirmed = false;
      let scaffoldingStarted = false;
      try {
        const files = discover(this.migrationsDir);
        const trackedFiles = this.allTrackedFiles(files);

      // NOTE: 0000_ helper files are discovered above (discover() does not filter
      // them out) but are intentionally never applied here — plan() excludes them
      // from all buckets (migration-planner.ts) and seedBaselineIfVirgin() skips
      // them too, so they are inert as far as this engine is concerned. See the
      // class doc comment on run() for why per-run creation was removed.

      // Step 3a: Scaffolding — create THIS phase's migration-helper objects (dropped
      // after reconcile+pending, unconditionally — see the finally block below).
      // Applied before any seeding/reconcile/pending work so bodies can CALL them.
        if (this.scaffolding && this.adapter.applyScaffolding) {
          const scaffoldPath = isAbsolute(this.scaffolding.filename)
            ? this.scaffolding.filename
            : join(this.migrationsDir, this.scaffolding.filename);
          scaffoldingStarted = true;
          await this.adapter.applyScaffolding(this.conn, scaffoldPath);
        }

        await this.repairFailedChecksums(trackedFiles);

      // Step 4: Seed baseline rows for a virgin DB (schema_migrations is empty).
        const seeded = await this.seedBaselineIfVirgin(files);

      // Step 5: Plan. Integrity lookup spans this dir ∪ the sibling phase dir(s)
      // (they share one schema_migrations table); classification stays scoped to
      // `files` (this phase only ever applies its own directory).
        const p = plan(files, await this.repo.all(), canonicalChecksumFile, trackedFiles);

        let reconciled = 0;
        let applied = 0;
        // Step 6: Reconcile — asserts-first; re-run body only when asserts are absent
        // or one failed (indicating the migration was only partially applied).
        for (const f of p.reconcile) {
          await this.requireLockHeld();
          const markedByAdapter = await this.reconcile(f.path);
          if (!markedByAdapter) {
            await this.requireLockHeld();
            await this.repo.markSuccess(f.version, 0);
          }
          reconciled++;
        }

        // Step 7: Pending — claim(success=0) → execute body → markSuccess(success=1).
        // A throw in executeStatements leaves the row at success=0 for later reconcile.
        for (const f of p.pending) {
          await this.requireLockHeld();
          const checksum = canonicalChecksumFile(f.path);
          await this.repo.claim(f.version, checksum, this.appliedBy); // autocommit → durable
          const start = Date.now();
          await this.executeStatements(f.path); // throws → row stays success=0
          await this.requireLockHeld();
          await this.repo.markSuccess(f.version, Date.now() - start);
          applied++;
        }
        return { seeded, reconciled, applied, pendingRemaining: 0 };
      } catch (e) {
        phaseFailed = true;
        if (this.adapter.rollbackTransaction) {
          try {
            await this.adapter.rollbackTransaction(this.conn);
            rollbackConfirmed = true;
          } catch (rollbackError) {
            console.warn(
              `rollback failed before scaffolding cleanup; cleanup will be skipped: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`,
            );
          }
        } else {
          console.warn('adapter cannot confirm rollback; scaffolding cleanup will be skipped');
        }
        throw e;
      } finally {
        // Step 7a: Scaffolding cleanup — drop every object the lease user defined,
        // so the ephemeral migrate user is never left a DEFINER (ER-4006). Runs
        // whether the reconcile/pending block above succeeded or threw (unconditional),
        // but ONLY when scaffolding is configured AND the lock is still held (a lost
        // lock means another runner may be concurrently active — do not touch the DB).
        if (
          scaffoldingStarted &&
          this.scaffolding &&
          (!phaseFailed || rollbackConfirmed) &&
          (await this.lockHeld())
        ) {
          try {
            await this.adapter.dropOwnedObjects(this.conn, this.scaffolding.leaseUser);
          } catch (cleanupErr) {
            // Log but do not rethrow — this must never mask a primary phase error.
            // A failed/partial sweep surfaces later via the eventual DROP USER
            // re-hitting ER-4006, which is visible and actionable.
            console.warn(
              `scaffolding cleanup (dropDefinerObjects) failed for lease user '${this.scaffolding.leaseUser}': ${
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
              }`,
            );
          }
        }
        }
    } catch (e) {
      primary = e;
      throw e;
    } finally {
      // release() never throws — it must not mask the primary error.
      // A non-clean release is the lost-lock tripwire: surface it only when
      // there is no primary error to preserve.
      const released = await this.adapter.releaseLock(this.conn);
      if (!released && primary === null) {
        // eslint-disable-next-line no-unsafe-finally
        throw new Error(
          'Lock was not held at release — a concurrent runner may have run. Re-run status and verify schema_migrations.',
        );
      }
    }
  }

  private async repairFailedChecksums(files: ReturnType<typeof discover>): Promise<void> {
    const filesByVersion = new Map(files.map((file) => [file.version, file]));
    for (const row of (await this.repo.all()).filter((candidate) => !candidate.success && !candidate.baselined)) {
      const file = filesByVersion.get(row.version);
      if (!file) continue;
      const repair = this.approvedRepairFor(row, file.path);
      if (repair) {
        await this.requireLockHeld();
        if (!this.repo.repairFailedChecksum) {
          throw new Error(`Adapter does not support audited failed-checksum repair for ${repair.version}`);
        }
        await this.repo.repairFailedChecksum(repair, this.appliedBy);
      }
    }
  }

  private approvedRepairFor(
    row: Awaited<ReturnType<SchemaMigrationsRepo['all']>>[number],
    path: string,
  ): FailedMigrationChecksumRepair | undefined {
    if (row.success || row.baselined) return undefined;
    const actualChecksum = canonicalChecksumFile(path);
    if (actualChecksum === row.checksum) return undefined;
    const matches = this.checksumRepairs.filter((repair) =>
      repair.version === row.version &&
      repair.oldChecksum === row.checksum &&
      repair.newChecksum === actualChecksum,
    );
    if (matches.length !== 1) return undefined;
    const repair = matches[0]!;
    if (repair.reason.trim().length === 0) {
      throw new Error(`Checksum repair reason must not be blank for ${repair.version}`);
    }
    return repair;
  }

  /**
   * Abort immediately if this session no longer holds the GET_LOCK.
   * A killed session or proxy reconnect would silently drop the lock server-side.
   */
  private async requireLockHeld(): Promise<void> {
    if (!(await this.adapter.lockHeld(this.conn))) {
      throw new Error(
        'Lost the migration lock mid-run (session killed or reconnected). Aborting to avoid concurrent DDL.',
      );
    }
  }

  /**
   * Non-throwing counterpart to requireLockHeld() — used by cleanup paths (e.g.
   * scaffolding's finally block) that must NOT touch the DB once the lock is lost,
   * but also must not themselves throw while already unwinding another error.
   *
   * `lock.isHeld()` runs `SELECT IS_USED_LOCK(...)`, which can itself REJECT on a
   * dead connection (killed session / proxy reconnect — exactly the scenario this
   * guard exists for), not just resolve to false. Since callers await this from a
   * `finally` block, an unswallowed rejection here would replace/mask whatever
   * primary error is already in flight (a throwing `finally` overrides the pending
   * exception). Treat any error the same as "lock not held": skip the guarded
   * cleanup rather than risk touching a possibly-dead connection or masking the
   * real error.
   */
  private async lockHeld(): Promise<boolean> {
    try {
      return await this.adapter.lockHeld(this.conn);
    } catch (e) {
      console.warn(
        `lock.isHeld() failed while checking scaffolding cleanup eligibility (treating as lock-not-held): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return false;
    }
  }

  /**
   * Execute every SQL statement in a file (text protocol, one at a time).
   * A failed CALL zn_assert_* signals SIGNAL '45000', which propagates as an
   * Error and leaves any pending claim row at success=0.
   *
   * The split+per-statement-execute logic lives on the adapter (`applyMigrationFile`)
   * — core only reads the file and hands the SQL text over.
   */
  private async executeStatements(path: string): Promise<void> {
    const sql = readFileSync(path, 'utf8');
    await this.adapter.applyMigrationFile(this.conn, sql);
  }

  /**
   * Reconcile a success=0 row per spec step 7a.
   *
   * Run only the file's explicitly marked CALL zn_assert_* postconditions FIRST:
   *  - If they exist and all pass → the migration is already fully applied;
   *    markSuccess WITHOUT re-running the body (avoids double-apply hazard for
   *    non-idempotent bodies).
   *  - If there is no marker, OR any marked assert throws → re-run the ENTIRE
   *    (idempotent) body, then markSuccess.
   *
   * New adapters perform the assertions/body only; the caller then performs the
   * final lock check and markSuccess. A legacy adapter can still call markSuccess
   * through the guarded repo supplied here, which enforces the same lock check.
   */
  private async reconcile(path: string): Promise<boolean> {
    const fileSql = readFileSync(path, 'utf8');
    const version = path.split('/').pop()!;
    let markedByAdapter = false;
    const guardedRepo: SchemaMigrationsRepo = {
      ensureTable: () => this.repo.ensureTable(),
      all: () => this.repo.all(),
      claim: (rowVersion, checksum, appliedBy) => this.repo.claim(rowVersion, checksum, appliedBy),
      markSuccess: async (rowVersion, executionMs) => {
        await this.requireLockHeld();
        await this.repo.markSuccess(rowVersion, executionMs);
        markedByAdapter = true;
      },
      seedBaseline: (rowVersion, checksum, appliedBy) =>
        this.repo.seedBaseline(rowVersion, checksum, appliedBy),
      ...(this.repo.repairFailedChecksum
        ? {
            repairFailedChecksum: (repair: FailedMigrationChecksumRepair, repairedBy: string) =>
              this.repo.repairFailedChecksum!(repair, repairedBy),
          }
        : {}),
    };
    await this.adapter.reconcile(this.conn, version, fileSql, guardedRepo);
    return markedByAdapter;
  }

  /**
   * Seed baselined rows for a virgin DB (schema_migrations has no rows yet).
   *
   * Reads the BASELINE_MARKER from baseline/00-baseline-schema.sql and seeds
   * a baselined row for every non-0000_ file whose prefix <= the marker.
   * Returns the number of rows seeded.
   */
  private async seedBaselineIfVirgin(files: ReturnType<typeof discover>): Promise<number> {
    if ((await this.repo.all()).length > 0) return 0;
    const marker = readBaselineMarker(join(this.migrationsDir, 'baseline', '00-baseline-schema.sql'));
    if (!marker) return 0; // no baseline file (unit/throwaway DB) → nothing to seed
    let n = 0;
    for (const f of files) {
      if (f.version.startsWith('0000_')) continue; // helpers are never seeded
      if (f.prefix <= marker) {
        await this.repo.seedBaseline(f.version, canonicalChecksumFile(f.path), this.appliedBy);
        n++;
      }
    }
    return n;
  }
}
