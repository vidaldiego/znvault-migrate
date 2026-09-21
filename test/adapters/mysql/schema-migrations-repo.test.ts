import { describe, expect, it } from 'vitest';
import type { MysqlConn } from '../../../src/adapters/mysql/mysql-conn.js';
import { SchemaMigrationsRepo } from '../../../src/adapters/mysql/schema-migrations-repo.js';

const repair = {
  version: '2026-09-18_001_compact-invoice-summary.sql',
  oldChecksum: 'old',
  newChecksum: 'new',
  reason: 'known failed migration defect',
};

function fakeDb(affectedRows: number) {
  const queries: string[] = [];
  const executions: Array<{ sql: string; params?: unknown[] }> = [];
  const db: MysqlConn = {
    connectionId: 1,
    async query(sql) {
      queries.push(sql);
      return [];
    },
    async execute(sql, params) {
      executions.push({ sql, params });
      return [{ affectedRows }, []];
    },
    async end() {},
  };
  return { db, queries, executions };
}

describe('SchemaMigrationsRepo.repairFailedChecksum', () => {
  it('compare-and-swaps the failed row and writes an audit record in one transaction', async () => {
    const { db, queries, executions } = fakeDb(1);

    await new SchemaMigrationsRepo(db).repairFailedChecksum(repair, 'candidate-test');

    expect(queries).toEqual(['START TRANSACTION', 'COMMIT']);
    expect(executions[0]?.sql).toContain('success = 0 AND baselined = 0');
    expect(executions[0]?.params).toEqual(['new', repair.version, 'old']);
    expect(executions[1]?.sql).toContain('INSERT INTO schema_migration_repair_audit');
    expect(executions[1]?.params).toEqual([
      repair.version,
      'old',
      'new',
      repair.reason,
      'candidate-test',
    ]);
  });

  it('rolls back and refuses when the failed row no longer exactly matches', async () => {
    const { db, queries, executions } = fakeDb(0);

    await expect(
      new SchemaMigrationsRepo(db).repairFailedChecksum(repair, 'candidate-test'),
    ).rejects.toThrow('no longer matches');

    expect(queries).toEqual(['START TRANSACTION', 'ROLLBACK']);
    expect(executions).toHaveLength(1);
  });

  it('preserves the compare-and-swap error when rollback also fails', async () => {
    const { db } = fakeDb(0);
    const originalQuery = db.query.bind(db);
    db.query = async (sql, params) => {
      if (sql === 'ROLLBACK') throw new Error('rollback connection failure');
      return originalQuery(sql, params);
    };

    await expect(
      new SchemaMigrationsRepo(db).repairFailedChecksum(repair, 'candidate-test'),
    ).rejects.toThrow('no longer matches');
  });
});
