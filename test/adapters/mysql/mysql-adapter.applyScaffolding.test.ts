/**
 * Unit tests for mysqlAdapter.applyScaffolding's per-statement lock-liveness
 * guard.
 *
 * Whole-branch review found that the port dropped the source runner's
 * per-statement `requireLockHeld()` check inside the scaffolding-apply loop
 * (`migration-runner.ts`), with no compensating control anywhere between
 * `acquireLock` and `applyScaffolding`. The fix restores the guard INSIDE the
 * adapter's `applyScaffolding` (both the scaffolding split/apply logic and the
 * lock module are MySQL-specific concerns, so this keeps `core/runner.ts`
 * engine-SQL-free while restoring the exact per-statement behavior).
 *
 * These tests exercise the REAL `mysqlAdapter.applyScaffolding` and the REAL
 * `lock.isHeld` (src/adapters/mysql/lock.ts) against a fake `MysqlConn` whose
 * `query` answers the exact `IS_USED_LOCK(?) = ? AS held` query `lock.isHeld`
 * issues — no module mocking, consistent with this repo's existing fake-based
 * test style (see runner.scaffolding.test.ts, scaffolding.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mysqlAdapter } from '../../../src/adapters/mysql/mysql-adapter.js';
import type { MysqlConn } from '../../../src/adapters/mysql/mysql-conn.js';

const CONNECTION_ID = 4242;

/** A scaffolding file with 2 distinct statements, so per-statement granularity is observable. */
const TWO_STATEMENT_SQL = [
  "SELECT 'stmt-one';",
  "SELECT 'stmt-two';",
].join('\n');

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds a fake MysqlConn whose `query`:
 *  - answers `lock.isHeld`'s `IS_USED_LOCK(?) = ? AS held` query by consuming
 *    the next value off `heldSequence` (defaulting to `true` once exhausted),
 *  - and otherwise records the executed statement into `executedStatements`.
 */
function makeFakeConn(
  heldSequence: boolean[],
  executedStatements: string[],
): MysqlConn {
  let heldCallIndex = 0;
  return {
    connectionId: CONNECTION_ID,
    async query(sql: string, _params?: unknown[]): Promise<unknown[]> {
      if (/IS_USED_LOCK/i.test(sql)) {
        const held = heldCallIndex < heldSequence.length ? heldSequence[heldCallIndex] : true;
        heldCallIndex++;
        return [{ held: held ? 1 : 0 }];
      }
      executedStatements.push(sql.trim());
      return [];
    },
    async execute(_sql: string, _params?: unknown[]): Promise<[unknown, unknown]> {
      throw new Error('not used in this test');
    },
    async end(): Promise<void> {},
  };
}

describe('mysqlAdapter.applyScaffolding — per-statement lock-liveness guard', () => {
  it('throws the lock-lost error and stops before running the remaining statements when the lock is not held', async () => {
    dir = mkdtempSync(join(tmpdir(), 'apply-scaffold-'));
    const scaffoldPath = join(dir, 'migration_utils.sql');
    writeFileSync(scaffoldPath, TWO_STATEMENT_SQL);

    const executed: string[] = [];
    // Held for the 1st statement's guard check, lost before the 2nd.
    const conn = makeFakeConn([true, false], executed);

    await expect(mysqlAdapter.applyScaffolding(conn, scaffoldPath)).rejects.toThrow(
      'Lost the migration lock mid-run (session killed or reconnected). Aborting to avoid concurrent DDL.',
    );

    // Only the first statement ran; the second was never reached.
    expect(executed).toEqual(["SELECT 'stmt-one'"]);
  });

  it('runs every statement when the lock stays held throughout', async () => {
    dir = mkdtempSync(join(tmpdir(), 'apply-scaffold-'));
    const scaffoldPath = join(dir, 'migration_utils.sql');
    writeFileSync(scaffoldPath, TWO_STATEMENT_SQL);

    const executed: string[] = [];
    const conn = makeFakeConn([true, true], executed);

    await expect(mysqlAdapter.applyScaffolding(conn, scaffoldPath)).resolves.toBeUndefined();

    expect(executed).toEqual(["SELECT 'stmt-one'", "SELECT 'stmt-two'"]);
  });
});
