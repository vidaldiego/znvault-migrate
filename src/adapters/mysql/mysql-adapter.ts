import type { Conn, EngineAdapter, EngineCredentials, SchemaMigrationsRepo as ISchemaMigrationsRepo } from '../engine-adapter.js';
import type { MysqlConn } from './mysql-conn.js';
import { openConnection, preflight } from './connection.js';
import * as lock from './lock.js';
import { splitStatements } from './sql-splitter.js';
import { readScaffoldingSql, dropDefinerObjects } from './scaffolding.js';
import { SchemaMigrationsRepo } from './schema-migrations-repo.js';

/**
 * True when a statement is a postcondition assertion call (zn_assert_* proc).
 * MySQL-convention detection, relocated verbatim from
 * znvault-plugin-payara/src/migrate/migration-runner.ts's private `isPostcondition`.
 */
function isPostcondition(stmt: string): boolean {
  return /^\s*CALL\s+zn_assert_/i.test(stmt);
}

/**
 * The concrete MySQL EngineAdapter. Wires the already-ported leaf modules
 * (lock, sql-splitter, scaffolding, schema-migrations-repo) and this file's
 * connection.ts into the engine-agnostic `EngineAdapter` interface consumed by
 * `core/runner.ts`. No new logic beyond delegation — the split-execute apply
 * logic and the asserts-first reconcile logic are relocated verbatim from the
 * source `migration-runner.ts` (`executeStatements` / `reconcile`).
 */
export const mysqlAdapter: EngineAdapter = {
  engine: 'mysql',

  openConnection(creds: EngineCredentials): Promise<Conn> {
    return openConnection(creds);
  },

  preflight(conn: Conn, requireWritePrimary: boolean): Promise<void> {
    return preflight(conn, requireWritePrimary);
  },

  acquireLock(conn: Conn): Promise<void> {
    return lock.acquire(conn as MysqlConn);
  },

  lockHeld(conn: Conn): Promise<boolean> {
    return lock.isHeld(conn as MysqlConn);
  },

  releaseLock(conn: Conn): Promise<boolean> {
    return lock.release(conn as MysqlConn);
  },

  /**
   * Relocated verbatim from migration-runner.ts's private `executeStatements`:
   * split the file's SQL into individual statements and execute each in order
   * over the text protocol.
   */
  async applyMigrationFile(conn: Conn, sql: string): Promise<void> {
    for (const stmt of splitStatements(sql)) {
      await conn.query(stmt);
    }
  },

  /**
   * Relocated verbatim from migration-runner.ts's private `reconcile(path)`:
   * asserts-first — run the file's trailing `CALL zn_assert_*` postconditions
   * first; if they all pass, the migration is already applied (markSuccess
   * without re-running the idempotent body). If there are no asserts, or any
   * assert throws, re-run the entire body, then markSuccess.
   *
   * FIDELITY NOTE (documented per task brief): the source's `reconcile(path)`
   * called `this.requireLockHeld()` a SECOND time here, immediately before
   * `repo.markSuccess(version, 0)` (a guard against a session kill happening
   * during the (possibly long) body re-execution). That per-reconcile guard is
   * intentionally OMITTED here — the interface's `reconcile` signature has no
   * lock hook, and lock-liveness semantics are owned by the core runner, not
   * this adapter. The core runner (`core/runner.ts`, reconcile loop) already
   * calls `await this.requireLockHeld()` immediately BEFORE invoking
   * `adapter.reconcile(...)` for each file, so the PRE-reconcile guard is
   * preserved. What's dropped is only the narrower POST-body-re-execution,
   * pre-markSuccess check. This is a minimal, deliberate fidelity relocation,
   * not an oversight — flagged here per the task brief's instruction to
   * document rather than silently decide.
   */
  async reconcile(
    conn: Conn,
    version: string,
    fileSql: string,
    repo: ISchemaMigrationsRepo,
  ): Promise<void> {
    const stmts = splitStatements(fileSql);
    const asserts = stmts.filter((s) => isPostcondition(s));

    let satisfied = false;
    if (asserts.length > 0) {
      try {
        for (const a of asserts) {
          await conn.query(a);
        }
        satisfied = true; // all asserts passed
      } catch {
        satisfied = false; // at least one assert failed → re-run body
      }
    }
    // satisfied = false also when asserts.length === 0 (no-asserts → always re-run)

    if (!satisfied) {
      // Re-run entire body — must be idempotent (spec requirement).
      // A genuinely failed CALL zn_assert_* will throw and propagate.
      for (const s of stmts) {
        await conn.query(s);
      }
    }

    await repo.markSuccess(version, 0);
  },

  schemaMigrationsRepo(conn: Conn): ISchemaMigrationsRepo {
    return new SchemaMigrationsRepo(conn as MysqlConn);
  },

  dropOwnedObjects(conn: Conn, leaseUser: string): Promise<number> {
    return dropDefinerObjects(conn, leaseUser);
  },

  /**
   * Read + split the scaffolding file (already resolved to an absolute path by
   * the core runner) and apply its statements over the text protocol. The core
   * runner passes an already-resolved absolute path in `scaffoldingFilePath`;
   * `readScaffoldingSql`'s `isAbsolute(filename) ? filename : join(migrationsDir,
   * filename)` short-circuits on an absolute filename, so the `migrationsDir`
   * argument is irrelevant here and passed as ''.
   *
   * FIDELITY NOTE: the source runner's scaffolding-apply loop
   * (`migration-runner.ts`) called `this.requireLockHeld()` before EACH
   * statement — a per-statement guard against a killed session / proxy
   * reconnect silently dropping the GET_LOCK server-side mid-apply. That
   * per-statement check is restored HERE, in the adapter, because both the
   * scaffolding split/apply logic and the lock module are MySQL-specific
   * concerns; `core/runner.ts` calls this method as a single unit and stays
   * engine-SQL-free.
   */
  async applyScaffolding(conn: Conn, scaffoldingFilePath: string): Promise<void> {
    const { statements } = readScaffoldingSql('', scaffoldingFilePath);
    for (const stmt of statements) {
      // Per-statement lock-liveness guard (faithful port of the source runner's
      // scaffolding loop): a killed session / proxy reconnect silently drops the
      // GET_LOCK server-side; abort before running further DDL on a lock-less session.
      if (!(await lock.isHeld(conn as MysqlConn))) {
        throw new Error(
          'Lost the migration lock mid-run (session killed or reconnected). Aborting to avoid concurrent DDL.',
        );
      }
      await conn.query(stmt);
    }
  },
};
