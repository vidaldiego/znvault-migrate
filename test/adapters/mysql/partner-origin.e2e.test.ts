import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../../../src/adapters/mysql/connection.js';
import type { MysqlConn } from '../../../src/adapters/mysql/mysql-conn.js';
import { mysqlAdapter } from '../../../src/adapters/mysql/mysql-adapter.js';
import { splitStatements } from '../../../src/adapters/mysql/sql-splitter.js';
import { SchemaMigrationsRepo } from '../../../src/adapters/mysql/schema-migrations-repo.js';
import { MigrationRunner } from '../../../src/core/runner.js';

const version = '2026-10-09_002_partner_sandbox_public_origin.sql';
const oldChecksum = '9d063c4a327c73e352fdf340ff4c33c47225f13404a3745fa0fd66e354587926';
const fixtures = join(import.meta.dirname, 'fixtures/partner-origin');
const rootCfg = {
  host: process.env.MYSQL_TEST_HOST!,
  port: Number(process.env.MYSQL_TEST_PORT ?? 33306),
  database: 'mysql',
  user: process.env.MYSQL_TEST_USER ?? 'root',
  password: process.env.MYSQL_TEST_PASSWORD ?? 'root',
  ssl: false,
};

describe.skipIf(!process.env.MYSQL_TEST_HOST)('online partner origin with a real migration lease', () => {
  async function fixture(test: (root: MysqlConn, lease: MysqlConn, dir: string, queries: string[], user: string) => Promise<void>) {
    const id = randomUUID().replaceAll('-', '').slice(0, 12);
    const database = 'znmig_origin_' + id;
    const user = 'znmig_origin_actor_' + id;
    const password = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'znmig-origin-'));
    const admin = await openConnection(rootCfg) as MysqlConn;
    let root: MysqlConn | undefined;
    let lease: MysqlConn | undefined;
    try {
      await admin.query('CREATE DATABASE ' + database);
      root = await openConnection({ ...rootCfg, database }) as MysqlConn;
      for (const statement of splitStatements(readFileSync(join(fixtures, 'schema.fixture'), 'utf8'))) await root.query(statement);
      for (const file of ['0000_migration-helpers.sql', version]) {
        copyFileSync(join(fixtures, file), join(dir, file));
      }
      for (const statement of splitStatements(readFileSync(join(dir, '0000_migration-helpers.sql'), 'utf8'))) await root.query(statement);
      // Managed root applies the exact source and leaves only a stable root-owned trigger.
      for (const statement of splitStatements(readFileSync(join(dir, version), 'utf8'))) await root.query(statement);
      // Production scaffolding belongs to the lease; stable trigger ownership does not.
      for (const statement of splitStatements(readFileSync(join(dir, '0000_migration-helpers.sql'), 'utf8'))) {
        const name = /\bDROP PROCEDURE IF EXISTS (zn_\w+)/i.exec(statement)?.[1];
        if (name) await root.query('DROP PROCEDURE IF EXISTS ' + name);
      }
      await admin.query("CREATE USER ?@'%' IDENTIFIED BY ?", [user, password]);
      await admin.query("GRANT ALL PRIVILEGES ON " + database + ".* TO ?@'%'", [user]);
      lease = await openConnection({ ...rootCfg, database, user, password }) as MysqlConn;
      const repo = new SchemaMigrationsRepo(root);
      await repo.ensureTable();
      await repo.claim(version, oldChecksum, 'interrupted-production-release');
      const queries: string[] = [];
      const query = lease.query.bind(lease);
      lease.query = async (sql, params) => { queries.push(sql); return query(sql, params); };
      await test(root, lease, dir, queries, user);
    } finally {
      await lease?.end().catch(() => {});
      await root?.end().catch(() => {});
      await admin.query("DROP USER IF EXISTS ?@'%'", [user]).catch(() => {});
      await admin.query('DROP DATABASE IF EXISTS ' + database).catch(() => {});
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('audits the exact failed repair, reconciles without body DDL, and survives lease revocation', async () => {
    await fixture(async (root, lease, dir, queries, user) => {
      const runner = new MigrationRunner(mysqlAdapter, lease, dir, 'online-recovery', [], {
        filename: '0000_migration-helpers.sql', leaseUser: user,
      });
      expect(await runner.run()).toMatchObject({ reconciled: 1, applied: 0 });
      expect(queries.some(sql => /\b(?:CREATE|DROP)\s+(?:DEFINER=.*?\s+)?TRIGGER|UPDATE\s+_mwm_part_b_integration/i.test(sql))).toBe(false);
      const rows = await root.query('SELECT old_checksum,new_checksum FROM schema_migration_repair_audit WHERE version=?', [version]) as Array<{ old_checksum: string; new_checksum: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.old_checksum).toBe(oldChecksum);
      expect(rows[0]?.new_checksum).toBe('33dc3d7fb7d076200c874e187bd121eb3adafd4c799e2fdcfc5e11059d2a2337');
      const state = await root.query('SELECT success FROM schema_migrations WHERE version=?', [version]) as Array<{ success: number }>;
      expect(Number(state[0]?.success)).toBe(1);
      await root.query("DROP USER ?@'%'", [user]);
      const guards = await root.query("SELECT DEFINER FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name='zn_mwm_remote_owner_update'") as Array<{ DEFINER: string }>;
      expect(guards).toEqual([{ DEFINER: 'root@localhost' }]);
      await root.query("UPDATE _mwm_part_b_integration SET name='still writable' WHERE binding_id='1'");
      await expect(root.query("UPDATE _mwm_part_b_integration SET partner_id=8 WHERE binding_id='1'")).rejects.toThrow('PARTNER_SANDBOX_OWNER_IMMUTABLE');
    });
  });

  it('a fresh or partial DDL attempt without stable-definer privileges fails before dropping protection', async () => {
    await fixture(async (root, lease, dir, queries, user) => {
      // Root-owned fixture reset; no externally serving API uses this schema.
      await root.query('DROP TRIGGER zn_mwm_remote_owner_update');
      await root.query("UPDATE _mwm_part_b_integration SET api_base_url='https://partners-sandbox.zincapp.com/api' WHERE binding_id='1'");
      const statements = splitStatements(readFileSync(join(dir, version), 'utf8'));
      const original = statements.find(sql => /TRIGGER zn_mwm_remote_owner_update BEFORE/.test(sql))!;
      await root.query(original);
      const runner = new MigrationRunner(mysqlAdapter, lease, dir, 'insufficient-lease', [], {
        filename: '0000_migration-helpers.sql', leaseUser: user,
      });
      await expect(runner.run()).rejects.toThrow();
      expect(queries.some(sql => /CREATE DEFINER=.*TRIGGER IF NOT EXISTS zn_mwm_remote_owner_update_cutover/s.test(sql))).toBe(true);
      expect(queries.some(sql => /^DROP TRIGGER IF EXISTS zn_mwm_remote_owner_update$/i.test(sql.trim()))).toBe(false);
      const guards = await root.query("SELECT DEFINER FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name='zn_mwm_remote_owner_update'") as Array<{ DEFINER: string }>;
      expect(guards).toEqual([{ DEFINER: 'root@localhost' }]);
      await expect(root.query("UPDATE _mwm_part_b_integration SET partner_id=8 WHERE binding_id='1'")).rejects.toThrow('PARTNER_SANDBOX_OWNER_IMMUTABLE');
      const state = await root.query('SELECT success FROM schema_migrations WHERE version=?', [version]) as Array<{ success: number }>;
      expect(Number(state[0]?.success)).toBe(0);
    });
  });
  it('an unexpected assigned origin cannot reconcile successfully or touch the guards', async () => {
    await fixture(async (root, lease, dir, queries, user) => {
      await root.query('DROP TRIGGER zn_mwm_remote_owner_update');
      await root.query("UPDATE _mwm_part_b_integration SET api_base_url='https://unexpected.invalid' WHERE binding_id='1'");
      const original = splitStatements(readFileSync(join(dir, version), 'utf8')).find(sql => /TRIGGER zn_mwm_remote_owner_update BEFORE/.test(sql))!;
      await root.query(original);
      const runner = new MigrationRunner(mysqlAdapter, lease, dir, 'unexpected-origin', [], {
        filename: '0000_migration-helpers.sql', leaseUser: user,
      });
      await expect(runner.run()).rejects.toThrow('Assigned sandbox transport must use an approved origin');
      expect(queries.some(sql => /\b(?:CREATE|DROP)\s+(?:DEFINER=.*?\s+)?TRIGGER/i.test(sql))).toBe(false);
      const state = await root.query('SELECT success FROM schema_migrations WHERE version=?', [version]) as Array<{ success: number }>;
      expect(Number(state[0]?.success)).toBe(0);
      await expect(root.query("UPDATE _mwm_part_b_integration SET partner_id=8 WHERE binding_id='1'")).rejects.toThrow('PARTNER_SANDBOX_OWNER_IMMUTABLE');
    });
  });

});
