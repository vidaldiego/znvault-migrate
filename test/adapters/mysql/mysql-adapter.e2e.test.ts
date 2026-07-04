import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConnection } from '../../../src/adapters/mysql/connection.js';
import type { MysqlConn } from '../../../src/adapters/mysql/mysql-conn.js';
import { mysqlAdapter } from '../../../src/adapters/mysql/mysql-adapter.js';
import { MigrationRunner } from '../../../src/core/runner.js';

/**
 * Self-contained real-MySQL-8.4 e2e — NOT a port of the corpus-coupled
 * runner.integration.test.ts (that test hardcodes the zincapi-parent
 * docs/migrations corpus, which this standalone package must not depend on).
 *
 * Proves the scaffolding create→CALL→drop→clean-revoke cycle end-to-end
 * against a real MySQL 8.4 server, entirely inside a throwaway schema +
 * throwaway lease user it creates and tears down itself — never touches the
 * plugin's zincdb corpus.
 *
 * Gated on MYSQL_TEST_HOST — skips cleanly when unset (e.g. CI without a DB).
 */
const HAVE_DB = !!process.env.MYSQL_TEST_HOST;
const rootCfg = {
  host: process.env.MYSQL_TEST_HOST!,
  port: Number(process.env.MYSQL_TEST_PORT ?? 33306),
  database: process.env.MYSQL_TEST_DB ?? 'zincdb',
  user: process.env.MYSQL_TEST_USER ?? 'root',
  password: process.env.MYSQL_TEST_PASSWORD ?? 'root',
  ssl: false,
};

// Unique-enough per-run identifiers so re-runs never collide with leftovers
// from a previous (possibly crashed) run.
const RUN_ID = Date.now().toString(36);
const SCHEMA = `znmig_e2e_${RUN_ID}`;
const LEASE_USER = `znmig_e2e_user_${RUN_ID}`;
const LEASE_PASSWORD = 'pw';

describe.skipIf(!HAVE_DB)('mysql adapter e2e (real MySQL 8.4)', () => {
  let rootConn: MysqlConn;
  let migrationsDir: string;

  /** Best-effort teardown of the throwaway schema + lease user. Never throws. */
  async function cleanupDbState(conn: MysqlConn): Promise<void> {
    await conn.query(`DROP DATABASE IF EXISTS \`${SCHEMA}\``).catch(() => {});
    await conn.query(`DROP USER IF EXISTS '${LEASE_USER}'@'%'`).catch(() => {});
  }

  beforeAll(async () => {
    rootConn = (await openConnection(rootCfg)) as MysqlConn;

    // Clean up any leftover state from a previous crashed run (defensive).
    await cleanupDbState(rootConn);

    // 1. Setup: throwaway schema + lease user with least-priv-ish grants.
    await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${SCHEMA}\``);
    await rootConn.query(
      `CREATE USER IF NOT EXISTS '${LEASE_USER}'@'%' IDENTIFIED BY '${LEASE_PASSWORD}'`,
    );
    await rootConn.query(`GRANT ALL PRIVILEGES ON \`${SCHEMA}\`.* TO '${LEASE_USER}'@'%'`);
    await rootConn.query(
      `GRANT CREATE ROUTINE, ALTER ROUTINE, EXECUTE ON \`${SCHEMA}\`.* TO '${LEASE_USER}'@'%'`,
    );
    await rootConn.query('FLUSH PRIVILEGES');

    // Temp migrations dir on disk: a scaffolding file + one pending migration.
    migrationsDir = mkdtempSync(join(tmpdir(), 'znmig-e2e-'));

    const scaffoldingSql = [
      'DROP PROCEDURE IF EXISTS zn_assert_probe;',
      'DELIMITER $$',
      'CREATE PROCEDURE zn_assert_probe() SQL SECURITY INVOKER',
      'BEGIN',
      '  SELECT 1;',
      'END $$',
      'DELIMITER ;',
      '',
    ].join('\n');
    // Scaffolding file must match discover()'s `0000_*.sql` helper convention —
    // discover() scans every *.sql file in migrationsDir and requires each to
    // match either 0000_*.sql (helper, inert to plan/seed) or the dated
    // migration pattern. A bare name here would otherwise throw.
    writeFileSync(join(migrationsDir, '0000_migration_utils.sql'), scaffoldingSql, 'utf8');

    const migrationSql = [
      'CREATE TABLE IF NOT EXISTS probe_table (id INT PRIMARY KEY);',
      'CALL zn_assert_probe();',
      '',
    ].join('\n');
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(migrationsDir, `${today}_001_probe.sql`), migrationSql, 'utf8');
  });

  afterAll(async () => {
    // 4. Teardown: always runs, even if an assertion above failed.
    await cleanupDbState(rootConn);
    await rootConn.end().catch(() => {});
    if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
  });

  it('applies a scaffolding-backed migration as the lease user, then leaves the lease user droppable (0 leftover definers, clean DROP USER)', async () => {
    // 2. Run as the lease user — the DEFINER of the scaffolding procedure becomes
    // the lease user (its own connection, own credentials).
    const leaseConn = (await openConnection({
      host: rootCfg.host,
      port: rootCfg.port,
      database: SCHEMA,
      user: LEASE_USER,
      password: LEASE_PASSWORD,
      ssl: false,
    })) as MysqlConn;

    try {
      const runner = new MigrationRunner(
        mysqlAdapter,
        leaseConn,
        migrationsDir,
        'e2e-test',
        [],
        { filename: join(migrationsDir, '0000_migration_utils.sql'), leaseUser: LEASE_USER },
      );

      const result = await runner.run();
      expect(result.applied).toBe(1);

      // 3. Clean teardown proof: the lease user must be DEFINER of ZERO stored
      // routines (dropOwnedObjects swept the scaffolding-created procedure).
      const routineRows = (await rootConn.query(
        'SELECT COUNT(*) AS cnt FROM information_schema.ROUTINES WHERE DEFINER = ?',
        [`${LEASE_USER}@%`],
      )) as { cnt: number }[];
      expect(Number(routineRows[0]?.cnt)).toBe(0);

      // The ER-4006 clean-revoke proof: DROP USER must now succeed. If
      // dropOwnedObjects had NOT run, this would fail with ER 4006 because the
      // lease user would still be a routine DEFINER.
      await expect(rootConn.query(`DROP USER '${LEASE_USER}'@'%'`)).resolves.toBeDefined();

      // Re-create for the shared afterAll cleanup (idempotent either way via
      // IF EXISTS / IF NOT EXISTS), so a second test run / crash mid-test still
      // tears down cleanly.
      await rootConn.query(
        `CREATE USER IF NOT EXISTS '${LEASE_USER}'@'%' IDENTIFIED BY '${LEASE_PASSWORD}'`,
      );
    } finally {
      await leaseConn.end().catch(() => {});
    }
  });
});
