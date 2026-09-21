import { describe, expect, it } from 'vitest';
import type { Conn, SchemaMigrationsRepo } from '../../../src/adapters/engine-adapter.js';
import { mysqlAdapter } from '../../../src/adapters/mysql/mysql-adapter.js';

const noOpRepo: SchemaMigrationsRepo = {
  async ensureTable() {},
  async all() { return []; },
  async claim() {},
  async markSuccess() { throw new Error('adapter must not mark success'); },
  async seedBaseline() {},
};

describe('mysql reconcile postconditions', () => {
  it('does not treat an early precondition as proof that the migration body completed', async () => {
    const queries: string[] = [];
    const conn: Conn = {
      async query(sql) {
        queries.push(sql.trim());
        return [];
      },
      async end() {},
    };
    const sql = `
      CALL zn_assert_table_exists('target_table');
      INSERT INTO target_table (id) VALUES (1);
    `;

    await mysqlAdapter.reconcile(conn, '2026-09-18_001_probe.sql', sql, noOpRepo);

    expect(queries).toContain("INSERT INTO target_table (id) VALUES (1)");
  });

  it('uses only an explicitly marked, assertion-only postcondition block', async () => {
    const queries: string[] = [];
    const conn: Conn = {
      async query(sql) {
        queries.push(sql.trim());
        return [];
      },
      async end() {},
    };
    const sql = `
      INSERT INTO target_table (id) VALUES (1);
      -- @reconcile-postconditions
      -- both assertions are durable completion evidence
      CALL zn_assert_table_exists('target_table');
      /* keep comments from changing classification */
      CALL zn_assert_true('SELECT COUNT(*) = 1 FROM target_table', 'target row');
    `;

    await mysqlAdapter.reconcile(conn, '2026-09-18_002_probe.sql', sql, noOpRepo);

    expect(queries).toHaveLength(2);
    expect(queries.every((sqlText) => /CALL\s+zn_assert_/i.test(sqlText))).toBe(true);
    expect(queries.some((sqlText) => /INSERT INTO/i.test(sqlText))).toBe(false);
  });

  it('rejects duplicate reconcile-postconditions markers instead of trusting the last one', async () => {
    const conn: Conn = {
      async query() { return []; },
      async end() {},
    };
    const sql = `
      -- @reconcile-postconditions
      CALL zn_assert_true('SELECT 0', 'must fail');
      -- @reconcile-postconditions
      CALL zn_assert_true('SELECT 1', 'passes');
    `;

    await expect(
      mysqlAdapter.reconcile(conn, '2026-09-18_003_probe.sql', sql, noOpRepo),
    ).rejects.toThrow('multiple reconcile-postconditions markers');
  });
});
