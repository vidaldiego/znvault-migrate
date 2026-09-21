// Path: znvault-migrate/src/index.ts
// Public API surface for @zincapp/znvault-migrate.
// Consumed by znvault-plugin-payara (Phase 2) and znvault-cli (Phase 3).

export type { MigrationConfig } from './config.js';
export { validateMigrationConfig } from './config.js';

export { MigrationRunner } from './core/runner.js';
export type { MigrationFile, MigrationRow, RunResult, MigrationPlan } from './core/types.js';
export type { FailedMigrationChecksumRepair } from './core/failed-checksum-repair.js';

export type { EngineAdapter, Conn, SchemaMigrationsRepo, EngineCredentials } from './adapters/engine-adapter.js';
export { mysqlAdapter } from './adapters/mysql/mysql-adapter.js';

// Error classes surfaced by the core so consumers can catch/discriminate them.
export { ChecksumMismatchError, OrphanTrackedRowError } from './core/planner.js';
export { DuplicatePrefixError } from './core/migration-files.js';

// Lease layer (Task 7): mint a dynamic-secrets lease → open a connection via
// the selected engine adapter → run the migration engine → revoke the lease.
export { runMigrations, defaultDeps } from './lease/run-migrations.js';
export type { RunMigrationsOpts, RunMigrationsDeps } from './lease/run-migrations.js';
export type { Lease } from './lease/dynamic-secrets-client.js';
export { makeDynamicSecretsClient } from './lease/dynamic-secrets-client.js';
