import type { MigrationRow } from '../core/types.js';

/** A live DB connection handle. */
export interface Conn {
  /**
   * Returns result ROWS DIRECTLY (unwrapped) — NOT a driver `[rows, meta]` tuple.
   *
   * DELIBERATE DIVERGENCE from dynamic-secrets `DatabaseClient.query()` (which returns a
   * `[rows, meta]` tuple, `types.ts:35`). ROWS-DIRECTLY is chosen because the existing plugin
   * runner already assumes it (`migrate/db.ts:85-88` unwraps the mysql2 tuple before returning)
   * and every core-runner call site expects rows. The adapter MUST unwrap its driver's result
   * to rows before returning. This exact tuple-vs-rows mismatch caused a real Critical bug before
   * (`scaffolding.ts:25-34`), so it is pinned. We mirror db-clients' STRUCTURE, NOT its query shape.
   */
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  end(): Promise<void>;
}

export interface SchemaMigrationsRepo {
  ensureTable(): Promise<void>;
  all(): Promise<MigrationRow[]>;
  claim(version: string, checksum: string, appliedBy: string): Promise<void>;
  markSuccess(version: string, executionMs: number): Promise<void>;
  seedBaseline(version: string, checksum: string, appliedBy: string): Promise<void>;
}

export interface EngineCredentials {
  host: string; port: number; database: string; user: string; password: string; ssl?: boolean;
}

/**
 * The engine seam. Only 'mysql' is implemented in this project; 'postgres' is a valid literal
 * so the interface is future-ready, but building a PG adapter is DEFERRED (§11).
 */
export interface EngineAdapter {
  readonly engine: 'mysql' | 'postgres';

  /** Open a DEDICATED (non-pool) connection — session-scoped locks require it. */
  openConnection(creds: EngineCredentials): Promise<Conn>;

  /**
   * Version check + optionally refuse a read-only/replica target. Engine SQL. Throws on unsafe target.
   * `requireWritePrimary`: true for a migrate run (reject a read-only replica), false for `status()`
   * (allow read-only). MUST preserve the existing two-mode behavior — `db.ts:113-115`,
   * called `preflight(db, true)` for migrate and `preflight(db, false)` for status
   * (`migration-runner.ts:87-89`). Dropping this flag would make `status()` wrongly reject replicas.
   */
  preflight(conn: Conn, requireWritePrimary: boolean): Promise<void>;

  /** Session-scoped migration lock. acquire throws on busy/timeout. */
  acquireLock(conn: Conn): Promise<void>;
  lockHeld(conn: Conn): Promise<boolean>;          // non-throwing; false on any error
  /**
   * Release the lock. Returns TRUE if the lock was cleanly held-and-released, FALSE if it was NOT
   * held at release time (a lost-lock signal). MUST NOT throw. The core runner uses the boolean:
   * if release returns false AND no primary error occurred, the runner throws
   * "Lock was not held at release — a concurrent runner may have run" (the lost-lock tripwire —
   * `migration-lock.ts:70-86`, `migration-runner.ts:218-223`). Returning `Promise<void>` would
   * erase this concurrency-corruption signal — do NOT simplify it away.
   */
  releaseLock(conn: Conn): Promise<boolean>;

  /** Apply one migration file. mysql: split into statements + execute each. */
  applyMigrationFile(conn: Conn, sql: string): Promise<void>;

  /**
   * Reconcile a file whose tracking row is success=0 (claimed-but-not-confirmed — a crash between
   * claim and confirm). Takes the file's `version` (derived by the core runner from the path) and
   * the `SchemaMigrationsRepo` so the adapter can `markSuccess(version, 0)` when the postconditions
   * pass — this matches the existing `reconcile(path)` at `migration-runner.ts:321-348` which derives
   * the version and calls `repo.markSuccess(version, 0)`. mysql: re-run only the trailing
   * `CALL zn_assert_*` postconditions; if they pass, the migration already applied → `markSuccess`
   * without re-executing.
   */
  reconcile(conn: Conn, version: string, fileSql: string, repo: SchemaMigrationsRepo): Promise<void>;

  schemaMigrationsRepo(conn: Conn): SchemaMigrationsRepo;

  /**
   * REQUIRED — the "leave the migrate user droppable" teardown (§2.3). Runs at phase end (in the
   * finally, if the lock is still held) — but ONLY WHEN SCAFFOLDING IS CONFIGURED (see the runner
   * contract below; the current runner only drops definer objects inside the scaffolding bracket —
   * `migration-runner.ts:194-196`, pinned by `test/migrate/migration-runner.scaffolding.test.ts:327-339`).
   *  - mysql: drop every object the lease user is the DEFINER of (dropDefinerObjects sweep); returns count.
   *  (A future PG adapter would implement its OWN teardown here — §11 — NOT built in this project.)
   */
  dropOwnedObjects(conn: Conn, leaseUser: string): Promise<number>;

  // ── OPTIONAL: create-scaffolding step (MySQL; a PG adapter would omit it — §2.3) ──
  /**
   * Read + split the scaffolding file into helper statements, and apply them as the lease user
   * (MySQL). Takes the RESOLVED scaffolding file path (the core runner resolves `scaffoldingFile`
   * against `migrationsDir` — the bare-vs-absolute rule — but the READING+SPLITTING is MySQL-specific,
   * `readScaffoldingSql`/`scaffolding.ts:13-22`, so it lives on the adapter, not core). Absent on a
   * PG adapter → the scaffolding bracket is a no-op.
   */
  applyScaffolding?(conn: Conn, scaffoldingFilePath: string): Promise<void>;
}
