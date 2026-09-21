import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Conn, EngineAdapter, SchemaMigrationsRepo } from '../../src/adapters/engine-adapter.js';
import { canonicalChecksumFile } from '../../src/core/checksum.js';
import { MigrationRunner } from '../../src/core/runner.js';
import type { MigrationRow } from '../../src/core/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('MigrationRunner lock guards', () => {
  it('does not repair a failed checksum after lock ownership is lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-lock-repair-'));
    dirs.push(dir);
    const version = '2026-09-18_001_compact-invoice-summary.sql';
    const path = join(dir, version);
    writeFileSync(path, "SELECT 'fixed';\n");
    const newChecksum = canonicalChecksumFile(path);
    const oldChecksum = 'approved-old';
    const rows: MigrationRow[] = [{
      version, checksum: oldChecksum, checksumAlgo: 'sha256-lf-v1', success: false, baselined: false,
    }];
    let repairCalls = 0;
    const repo: SchemaMigrationsRepo = {
      async ensureTable() {},
      async all() { return rows; },
      async claim() {},
      async markSuccess() {},
      async seedBaseline() {},
      async repairFailedChecksum() { repairCalls++; },
    };
    const adapter: EngineAdapter = {
      engine: 'mysql',
      async openConnection() { throw new Error('not used'); },
      async preflight() {},
      async acquireLock() {},
      async lockHeld() { return false; },
      async releaseLock() { return false; },
      async applyMigrationFile() {},
      async reconcile(_conn, rowVersion, _sql, repoArg) {
        await repoArg.markSuccess(rowVersion, 0);
      },
      schemaMigrationsRepo() { return repo; },
      async dropOwnedObjects() { return 0; },
    };
    const runner = new (MigrationRunner as unknown as new (...args: unknown[]) => MigrationRunner)(
      adapter, {} as Conn, dir, 'candidate-test', [], undefined,
      [{ version, oldChecksum, newChecksum, reason: 'known failed migration defect' }],
    );

    await expect(runner.run()).rejects.toThrow('Lost the migration lock mid-run');
    expect(repairCalls).toBe(0);
  });

  it('does not mark a reconciled row successful when the lock is lost after assertions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-lock-reconcile-'));
    dirs.push(dir);
    const version = '2026-09-18_002_reconcile.sql';
    const path = join(dir, version);
    writeFileSync(path, '-- @reconcile-postconditions\nCALL zn_assert_true();\n');
    const row: MigrationRow = {
      version,
      checksum: canonicalChecksumFile(path),
      checksumAlgo: 'sha256-lf-v1',
      success: false,
      baselined: false,
    };
    let lockChecks = 0;
    let markCalls = 0;
    const repo: SchemaMigrationsRepo = {
      async ensureTable() {},
      async all() { return [{ ...row }]; },
      async claim() {},
      async markSuccess() { markCalls++; row.success = true; },
      async seedBaseline() {},
      async repairFailedChecksum() {},
    };
    const adapter: EngineAdapter = {
      engine: 'mysql',
      async openConnection() { throw new Error('not used'); },
      async preflight() {},
      async acquireLock() {},
      async lockHeld() { lockChecks++; return lockChecks === 1; },
      async releaseLock() { return false; },
      async applyMigrationFile() {},
      async reconcile(_conn, rowVersion, _sql, repoArg) {
        await repoArg.markSuccess(rowVersion, 0);
      },
      schemaMigrationsRepo() { return repo; },
      async dropOwnedObjects() { return 0; },
    };
    const runner = new MigrationRunner(adapter, {} as Conn, dir, 'candidate-test');

    await expect(runner.run()).rejects.toThrow('Lost the migration lock mid-run');
    expect(markCalls).toBe(0);
    expect(row.success).toBe(false);
  });
});
