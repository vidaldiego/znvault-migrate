/**
 * Unit tests for the scaffolding bracket in MigrationRunner.run().
 *
 * Binding contract under test (see .superpowers/sdd/task-5-brief.md):
 *  1. Order: scaffold-apply → reconcile → pending → scaffold-drop.
 *  2. Unconditional cleanup: scaffold-drop still runs even when a pending
 *     migration throws (the phase fails, but the drop must not be skipped).
 *  3. No-op: constructing the runner WITHOUT a scaffolding config performs
 *     zero apply/drop calls — existing (4-arg, now 5-arg-minus-scaffolding)
 *     callers are byte-identical.
 *  4. Lock-lost guard: if the cleanup's lock-held check rejects (dead connection
 *     during IS_USED_LOCK — not just a clean "not held" result), the drop is
 *     skipped and the guard's own rejection never masks the primary phase's
 *     result/error (success stays success, the real failure still propagates).
 *  5. Cleanup-failure containment: if dropOwnedObjects itself throws, that
 *     failure is logged and swallowed — a successful phase still returns its
 *     RunResult, and a failing phase's primary error still propagates unmasked.
 *
 * This is a UNIT test of the runner's control flow ONLY. Instead of mocking a
 * MySQL-specific scaffolding module (there is none in core), the runner is
 * constructed with a FAKE `EngineAdapter` whose methods trace into `trace`
 * (mirroring how the source's fake `Db` traced control-flow via SQL matching).
 * The fake adapter's `schemaMigrationsRepo()` returns a fake repo backed by an
 * in-memory row store, so plan()/discover()/canonicalChecksumFile() all run
 * FOR REAL against a real temp migrations directory — this proves the bracket
 * against the actual run() control flow, not a re-faked planner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineAdapter, Conn, SchemaMigrationsRepo } from '../../src/adapters/engine-adapter.js';
import type { MigrationRow } from '../../src/core/types.js';
import { MigrationRunner } from '../../src/core/runner.js';

const dropCalls: string[] = [];
const trace: string[] = [];

// Settable from within a test to make the fake dropOwnedObjects reject —
// reset in beforeEach so it never leaks between tests.
let dropShouldThrow = false;

/**
 * A fake `EngineAdapter` that traces control-flow events into `trace`,
 * mirroring the source's fake `Db` (which matched on SQL text). The fake
 * `schemaMigrationsRepo()` is backed by an in-memory row store so plan() and
 * the real reconcile/pending classification run for real.
 *
 * `isUsedLockRejectAfter` lets a test make `lockHeld()` reject starting from a
 * given 1-based call index, so it can simulate a connection that dies partway
 * through a run — specifically, surviving every `requireLockHeld()` call in
 * the main phase (so the primary work completes/fails normally) and only
 * rejecting on the LAST call, which is always the scaffolding cleanup's
 * non-throwing `lockHeld()` guard in the `finally` block (the only caller of
 * the non-throwing wrapper in the runner). Undefined/omitted → lockHeld()
 * always reports the lock held.
 */
function makeFakeAdapter(
  opts: {
    throwOnPending?: boolean;
    isUsedLockRejectAfter?: number;
    throwOnRepoAll?: boolean;
    throwOnRollback?: boolean;
    throwOnScaffolding?: boolean;
  } = {},
): EngineAdapter {
  let lockHeldCallCount = 0;
  const rows: MigrationRow[] = [];

  const repo: SchemaMigrationsRepo = {
    async ensureTable(): Promise<void> {},
    async all(): Promise<MigrationRow[]> {
      if (opts.throwOnRepoAll && trace.includes('scaffold-apply')) {
        trace.push('repo-all-failed');
        throw new Error('boom: repo all failed after scaffolding');
      }
      return rows;
    },
    async claim(version: string, checksum: string, appliedBy: string): Promise<void> {
      rows.push({ version, checksum, checksumAlgo: 'sha256-lf-v1', success: false, baselined: false });
      void appliedBy;
    },
    async markSuccess(version: string, _executionMs: number): Promise<void> {
      const row = rows.find((r) => r.version === version);
      if (row) row.success = true;
    },
    async seedBaseline(version: string, checksum: string, appliedBy: string): Promise<void> {
      rows.push({ version, checksum, checksumAlgo: 'sha256-lf-v1', success: true, baselined: true });
      void appliedBy;
    },
    async repairFailedChecksum(): Promise<void> {
      throw new Error('no checksum repair expected in scaffolding tests');
    },
  };

  const adapter: EngineAdapter = {
    engine: 'mysql',
    async openConnection(): Promise<Conn> {
      throw new Error('not used in this test');
    },
    async preflight(): Promise<void> {},
    async acquireLock(): Promise<void> {},
    async lockHeld(): Promise<boolean> {
      lockHeldCallCount++;
      if (
        opts.isUsedLockRejectAfter !== undefined &&
        lockHeldCallCount > opts.isUsedLockRejectAfter
      ) {
        throw new Error('boom: connection dead (simulated) during IS_USED_LOCK');
      }
      return true;
    },
    async releaseLock(): Promise<boolean> {
      return true;
    },
    async applyMigrationFile(_conn: Conn, sql: string): Promise<void> {
      if (/'pending-body'/.test(sql)) {
        trace.push('pending');
        if (opts.throwOnPending) throw new Error('boom: pending migration failed');
      }
    },
    async reconcile(_conn: Conn, _version: string, fileSql: string): Promise<void> {
      if (/'reconcile-body'/.test(fileSql)) {
        trace.push('reconcile');
      }
    },
    async rollbackTransaction(): Promise<void> {
      trace.push('rollback');
      if (opts.throwOnRollback) throw new Error('boom: rollback failed');
    },
    schemaMigrationsRepo(): SchemaMigrationsRepo {
      return repo;
    },
    async dropOwnedObjects(_conn: Conn, leaseUser: string): Promise<number> {
      trace.push('scaffold-drop');
      dropCalls.push(leaseUser);
      if (dropShouldThrow) throw new Error('boom: dropDefinerObjects failed');
      return 1;
    },
    async applyScaffolding(): Promise<void> {
      trace.push('scaffold-apply');
      if (opts.throwOnScaffolding) throw new Error('boom: scaffolding partially applied');
    },
  };

  return adapter;
}

const fakeConn = {} as Conn;

let dir: string;

beforeEach(() => {
  trace.length = 0;
  dropCalls.length = 0;
  dropShouldThrow = false;
  dir = mkdtempSync(join(tmpdir(), 'runner-scaffold-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MigrationRunner scaffolding bracket', () => {
  it('applies scaffolding BEFORE migrations and drops definer objects AFTER reconcile/pending', async () => {
    // A single pending migration whose body is traced as 'pending'.
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const adapter = makeFakeAdapter();
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(result.applied).toBe(1);
  });

  it('applies scaffolding before a reconcile row and drops after it, in order', async () => {
    // Pre-seed a success=0 row so plan() routes this file to reconcile, not pending.
    const migrationPath = join(dir, '2026-07-02_001_probe.sql');
    writeFileSync(migrationPath, "SELECT 'reconcile-body';\n");

    const adapter = makeFakeAdapter();
    // Seed a success=0 row directly against the fake repo's backing store via claim(),
    // simulating a crashed prior run — the real checksum keeps plan() from throwing.
    const { canonicalChecksumFile } = await import('../../src/core/checksum.js');
    const repo = adapter.schemaMigrationsRepo(fakeConn);
    await repo.claim('2026-07-02_001_probe.sql', canonicalChecksumFile(migrationPath), 'prior-runner');

    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    expect(trace).toEqual(['scaffold-apply', 'reconcile', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(result.reconciled).toBe(1);
  });

  it('drops definer objects even when a pending migration throws (unconditional cleanup)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const adapter = makeFakeAdapter({ throwOnPending: true });
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    // scaffold-apply happened, pending was attempted (and threw), and — critically —
    // scaffold-drop STILL ran despite the thrown error.
    expect(trace).toEqual(['scaffold-apply', 'pending', 'rollback', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
  });

  it('drops partially-created scaffolding when failure happens before planning', async () => {
    const adapter = makeFakeAdapter({ throwOnRepoAll: true });
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    await expect(runner.run()).rejects.toThrow('repo all failed after scaffolding');

    expect(trace).toEqual(['scaffold-apply', 'repo-all-failed', 'rollback', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
  });

  it('drops partially-created scaffolding when applyScaffolding itself throws', async () => {
    const adapter = makeFakeAdapter({ throwOnScaffolding: true });
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    await expect(runner.run()).rejects.toThrow('scaffolding partially applied');

    expect(trace).toEqual(['scaffold-apply', 'rollback', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
  });

  it('preserves the primary error and skips cleanup DDL when rollback cannot be confirmed', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");
    const adapter = makeFakeAdapter({ throwOnPending: true, throwOnRollback: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    await expect(runner.run()).rejects.toThrow('boom: pending migration failed');

    expect(trace).toEqual(['scaffold-apply', 'pending', 'rollback']);
    expect(trace).not.toContain('scaffold-drop');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rollback failed before scaffolding cleanup'));
    warnSpy.mockRestore();
  });

  it('skips the drop (no masking) when the lock-held check rejects during cleanup, on a SUCCESSFUL phase', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    // 3 lockHeld() calls happen before cleanup on the success path (1 for the
    // scaffold-apply statement — NOTE: applyScaffolding itself is a single fake
    // call with no requireLockHeld() wrapper, so the counted calls are the
    // pending loop's before-claim/after-exec requireLockHeld() calls) — the
    // 4th call is the scaffolding finally guard's lockHeld(), which we make
    // reject here to simulate a connection that died right as cleanup began
    // (e.g. killed session / proxy reconnect).
    const adapter = makeFakeAdapter({ isUsedLockRejectAfter: 2 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    // The primary phase succeeded and its result is unchanged — a rejecting
    // lock-held check must not turn a successful phase into a failure.
    expect(result).toEqual({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    // dropOwnedObjects must NOT be called: the lock-held guard rejected, which
    // is treated as "lock not held" — don't dial the DB under a lost/dead lock.
    expect(trace).toEqual(['scaffold-apply', 'pending']);
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    // The lockHeld() rejection itself is logged, not silently dropped.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock.isHeld() failed'));

    warnSpy.mockRestore();
  });

  it('skips the drop (no masking) when the lock-held check rejects during cleanup, on a FAILING phase', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    // On the throw path only 1 requireLockHeld() call happens before cleanup
    // (the pending loop's before-claim requireLockHeld() call — the throw
    // inside executeStatements pre-empts the after-exec requireLockHeld() call)
    // — so the 2nd lockHeld() call is the cleanup guard's, which we make reject.
    const adapter = makeFakeAdapter({ throwOnPending: true, isUsedLockRejectAfter: 1 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    // The PRIMARY error (from the pending migration body) must still surface —
    // a rejecting lock-held check in the cleanup guard must not mask it or
    // replace it with its own error.
    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    expect(trace).toEqual(['scaffold-apply', 'pending', 'rollback']);
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('lock.isHeld() failed'));

    warnSpy.mockRestore();
  });

  it('swallows a dropOwnedObjects failure on a SUCCESSFUL phase (cleanup failure does not turn success into failure)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    dropShouldThrow = true;
    const adapter = makeFakeAdapter();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    const result = await runner.run();

    // The successful phase result is returned even though cleanup failed.
    expect(result).toEqual({ seeded: 0, reconciled: 0, applied: 1, pendingRemaining: 0 });
    // The drop WAS attempted (unlike the lock-lost tests above) — it just failed.
    expect(trace).toEqual(['scaffold-apply', 'pending', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropDefinerObjects'));

    warnSpy.mockRestore();
  });

  it('swallows a dropOwnedObjects failure on a FAILING phase (cleanup failure does not mask the primary error)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    dropShouldThrow = true;
    const adapter = makeFakeAdapter({ throwOnPending: true });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner', [], {
      filename: 'migration_utils.sql',
      leaseUser: 'v_migrate_abc',
    });

    // The PRIMARY error (pending migration body) must still propagate — the
    // cleanup's own failure must not replace or mask it.
    await expect(runner.run()).rejects.toThrow(/boom: pending migration failed/);

    expect(trace).toEqual(['scaffold-apply', 'pending', 'rollback', 'scaffold-drop']);
    expect(dropCalls).toEqual(['v_migrate_abc']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dropDefinerObjects'));

    warnSpy.mockRestore();
  });

  it('skips scaffolding entirely when constructed without scaffolding config (existing callers unaffected)', async () => {
    writeFileSync(join(dir, '2026-07-02_001_probe.sql'), "SELECT 'pending-body';\n");

    const adapter = makeFakeAdapter();
    // No scaffolding arg at all (5th positional param omitted).
    const runner = new MigrationRunner(adapter, fakeConn, dir, 'test-runner');

    const result = await runner.run();

    expect(trace).toEqual(['pending']);
    expect(trace).not.toContain('scaffold-apply');
    expect(trace).not.toContain('scaffold-drop');
    expect(dropCalls).toEqual([]);
    expect(result.applied).toBe(1);
  });
});
