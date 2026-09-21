import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Conn, EngineAdapter, SchemaMigrationsRepo } from '../../src/adapters/engine-adapter.js';
import { canonicalChecksumFile } from '../../src/core/checksum.js';
import { MigrationRunner } from '../../src/core/runner.js';
import { ChecksumMismatchError } from '../../src/core/planner.js';
import type { MigrationRow } from '../../src/core/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('failed migration checksum repair', () => {
  it('repairs only the exact approved failed row, audits it, then reconciles it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-checksum-repair-'));
    dirs.push(dir);
    const version = '2026-09-18_001_compact-invoice-summary.sql';
    const migrationPath = join(dir, version);
    writeFileSync(migrationPath, "SELECT 'fixed-body';\n");
    const newChecksum = canonicalChecksumFile(migrationPath);
    const oldChecksum = '3b274a7d44a61ede04afae8926dff54d358a507777da90c726920568168ce57c';
    const rows: MigrationRow[] = [{
      version,
      checksum: oldChecksum,
      checksumAlgo: 'sha256-lf-v1',
      success: false,
      baselined: false,
    }];
    const repairs: Array<{ version: string; oldChecksum: string; newChecksum: string; reason: string; repairedBy: string }> = [];

    const repo: SchemaMigrationsRepo = {
      async ensureTable() {},
      async all() { return rows.map((row) => ({ ...row })); },
      async claim() { throw new Error('not pending'); },
      async markSuccess(rowVersion) {
        const row = rows.find((candidate) => candidate.version === rowVersion)!;
        row.success = true;
      },
      async seedBaseline() {},
      async repairFailedChecksum(repair, repairedBy) {
        const row = rows.find((candidate) => candidate.version === repair.version)!;
        if (row.success || row.baselined || row.checksum !== repair.oldChecksum) {
          throw new Error('repair compare-and-swap rejected');
        }
        row.checksum = repair.newChecksum;
        repairs.push({ ...repair, repairedBy });
      },
    };
    const adapter: EngineAdapter = {
      engine: 'mysql',
      async openConnection() { throw new Error('not used'); },
      async preflight() {},
      async acquireLock() {},
      async lockHeld() { return true; },
      async releaseLock() { return true; },
      async applyMigrationFile() {},
      async reconcile() {},
      schemaMigrationsRepo() { return repo; },
      async dropOwnedObjects() { return 0; },
    };
    const approved = [{
      version,
      oldChecksum,
      newChecksum,
      reason: 'Replace the failed migration that referenced a nonexistent column',
    }];
    const runner = new (MigrationRunner as unknown as new (...args: unknown[]) => MigrationRunner)(
      adapter,
      {} as Conn,
      dir,
      'candidate-test',
      [],
      undefined,
      approved,
    );

    await expect(runner.status()).resolves.toEqual({ applied: 0, reconcile: 1, pending: 0 });
    expect(rows[0]?.checksum).toBe(oldChecksum);

    await expect(runner.run()).resolves.toEqual({ seeded: 0, reconciled: 1, applied: 0, pendingRemaining: 0 });
    expect(rows[0]).toMatchObject({ checksum: newChecksum, success: true });
    expect(repairs).toEqual([{ ...approved[0], repairedBy: 'candidate-test' }]);
  });

  it('repairs an approved failed row in the sibling phase before integrity planning', async () => {
    const preDir = mkdtempSync(join(tmpdir(), 'runner-checksum-pre-'));
    const postDir = mkdtempSync(join(tmpdir(), 'runner-checksum-post-'));
    dirs.push(preDir, postDir);
    const version = '2026-09-18_001_compact-invoice-summary.sql';
    const migrationPath = join(postDir, version);
    writeFileSync(migrationPath, "SELECT 'fixed-body';\n");
    const newChecksum = canonicalChecksumFile(migrationPath);
    const oldChecksum = '3b274a7d44a61ede04afae8926dff54d358a507777da90c726920568168ce57c';
    const rows: MigrationRow[] = [{
      version,
      checksum: oldChecksum,
      checksumAlgo: 'sha256-lf-v1',
      success: false,
      baselined: false,
    }];
    let repaired = 0;
    const repo: SchemaMigrationsRepo = {
      async ensureTable() {},
      async all() { return rows.map((row) => ({ ...row })); },
      async claim() {},
      async markSuccess() {},
      async seedBaseline() {},
      async repairFailedChecksum(repair) {
        rows[0]!.checksum = repair.newChecksum;
        repaired++;
      },
    };
    const adapter: EngineAdapter = {
      engine: 'mysql',
      async openConnection() { throw new Error('not used'); },
      async preflight() {},
      async acquireLock() {},
      async lockHeld() { return true; },
      async releaseLock() { return true; },
      async applyMigrationFile() {},
      async reconcile() {},
      schemaMigrationsRepo() { return repo; },
      async dropOwnedObjects() { return 0; },
    };
    const runner = new (MigrationRunner as unknown as new (...args: unknown[]) => MigrationRunner)(
      adapter,
      {} as Conn,
      preDir,
      'candidate-test',
      [postDir],
      undefined,
      [{ version, oldChecksum, newChecksum, reason: 'known failed migration defect' }],
    );

    await expect(runner.status()).resolves.toEqual({ applied: 0, reconcile: 0, pending: 0 });
    await expect(runner.run()).resolves.toEqual({ seeded: 0, reconciled: 0, applied: 0, pendingRemaining: 0 });
    expect(repaired).toBe(1);
    expect(rows[0]?.checksum).toBe(newChecksum);
  });

  it.each([
    { label: 'successful', success: true, baselined: false, storedChecksum: 'approved-old' },
    { label: 'baselined', success: false, baselined: true, storedChecksum: 'approved-old' },
    { label: 'different failed checksum', success: false, baselined: false, storedChecksum: 'other-old' },
  ])('does not repair a $label row', async ({ success, baselined, storedChecksum }) => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-checksum-reject-'));
    dirs.push(dir);
    const version = '2026-09-18_001_compact-invoice-summary.sql';
    const migrationPath = join(dir, version);
    writeFileSync(migrationPath, "SELECT 'fixed-body';\n");
    const newChecksum = canonicalChecksumFile(migrationPath);
    const row: MigrationRow = {
      version,
      checksum: storedChecksum,
      checksumAlgo: 'sha256-lf-v1',
      success,
      baselined,
    };
    const repo: SchemaMigrationsRepo = {
      async ensureTable() {},
      async all() { return [{ ...row }]; },
      async claim() {},
      async markSuccess() {},
      async seedBaseline() {},
      async repairFailedChecksum() { throw new Error('repair must not run'); },
    };
    const adapter: EngineAdapter = {
      engine: 'mysql',
      async openConnection() { throw new Error('not used'); },
      async preflight() {},
      async acquireLock() {},
      async lockHeld() { return true; },
      async releaseLock() { return true; },
      async applyMigrationFile() {},
      async reconcile() {},
      schemaMigrationsRepo() { return repo; },
      async dropOwnedObjects() { return 0; },
    };
    const runner = new (MigrationRunner as unknown as new (...args: unknown[]) => MigrationRunner)(
      adapter,
      {} as Conn,
      dir,
      'candidate-test',
      [],
      undefined,
      [{
        version,
        oldChecksum: 'approved-old',
        newChecksum,
        reason: 'known failed migration defect',
      }],
    );

    await expect(runner.status()).rejects.toBeInstanceOf(ChecksumMismatchError);
  });
});
