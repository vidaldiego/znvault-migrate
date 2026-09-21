import type { Conn, EngineAdapter, EngineCredentials, SchemaMigrationsRepo as ISchemaMigrationsRepo } from '../engine-adapter.js';
import type { MysqlConn } from './mysql-conn.js';
import { openConnection, preflight } from './connection.js';
import * as lock from './lock.js';
import { splitStatements } from './sql-splitter.js';
import { readScaffoldingSql, dropDefinerObjects } from './scaffolding.js';
import { SchemaMigrationsRepo } from './schema-migrations-repo.js';

/**
 * True when a statement is a postcondition assertion call (zn_assert_* proc),
 * allowing only non-executable comments before the CALL.
 */
function withoutLeadingComments(statement: string): string {
  let code = statement.trimStart();
  for (;;) {
    if (code.startsWith('--') || code.startsWith('#')) {
      const newline = code.indexOf('\n');
      if (newline < 0) return '';
      code = code.slice(newline + 1).trimStart();
      continue;
    }
    if (code.startsWith('/*') && !code.startsWith('/*!')) {
      const end = code.indexOf('*/', 2);
      if (end < 0) return '';
      code = code.slice(end + 2).trimStart();
      continue;
    }
    return code;
  }
}

function isPostcondition(stmt: string): boolean {
  return /^CALL\s+zn_assert_/i.test(withoutLeadingComments(stmt));
}

function markedPostconditions(sql: string, version: string): string[] {
  const marker = /^\s*--\s*@reconcile-postconditions\s*$/gim;
  const matches = [...sql.matchAll(marker)];
  if (matches.length === 0) return [];
  if (matches.length > 1) {
    throw new Error(`Migration ${version} contains multiple reconcile-postconditions markers`);
  }
  const match = matches[0]!;
  const statements = splitStatements(sql.slice(match.index! + match[0].length));
  if (statements.length === 0) {
    throw new Error(`Migration ${version} has an empty reconcile-postconditions block`);
  }
  if (!statements.every((statement) => isPostcondition(statement))) {
    throw new Error(`Migration ${version} contains a non-assertion after @reconcile-postconditions`);
  }
  return statements;
}

/**
 * The concrete MySQL EngineAdapter. Wires the already-ported leaf modules
 * (lock, sql-splitter, scaffolding, schema-migrations-repo) and this file's
 * connection.ts into the engine-agnostic `EngineAdapter` interface consumed by
 * `core/runner.ts`.
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
   * Asserts-first reconciliation is available only for the statements after an
   * explicit `-- @reconcile-postconditions` marker. Every statement in that
   * block must be a `CALL zn_assert_*`; legacy files without the marker re-run
   * their complete idempotent body. This prevents an early precondition from
   * being mistaken for durable proof that the body completed.
   *
   * The adapter intentionally does not mark schema_migrations successful. The
   * core runner owns that state change so it can re-check the session lock after
   * the assertions/body and immediately before markSuccess.
   */
  async reconcile(
    conn: Conn,
    version: string,
    fileSql: string,
  ): Promise<void> {
    const stmts = splitStatements(fileSql);
    const asserts = markedPostconditions(fileSql, version);

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
  },

  async rollbackTransaction(conn: Conn): Promise<void> {
    await conn.query('ROLLBACK');
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
