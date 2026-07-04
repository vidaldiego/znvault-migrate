import { describe, it, expect } from 'vitest';
import { validateMigrationConfig, type MigrationConfig } from '../src/config.js';

describe('validateMigrationConfig', () => {
  it('errors when engine is missing', () => {
    const cfg = { roleId: 'dbr_x', migrationsDir: '/m' } as unknown as MigrationConfig;
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /engine/i.test(e))).toBe(true);
  });

  it('errors when engine is not mysql or postgres', () => {
    const cfg = { engine: 'sqlite', roleId: 'dbr_x', migrationsDir: '/m' } as unknown as MigrationConfig;
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /engine/i.test(e))).toBe(true);
  });

  it('errors with the exact deferred message when engine is postgres', () => {
    const cfg: MigrationConfig = { engine: 'postgres', roleId: 'dbr_x', migrationsDir: '/m' };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors).toContain(
      'postgres migrations are not yet supported (the PostgreSQL adapter is a deferred project — see the znvault-migrate PostgreSQL design)',
    );
  });

  it('errors when roleId is empty', () => {
    const cfg: MigrationConfig = { engine: 'mysql', roleId: '', migrationsDir: '/m' };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /roleId/i.test(e))).toBe(true);
  });

  it('errors when roleId is missing', () => {
    const cfg = { engine: 'mysql', migrationsDir: '/m' } as unknown as MigrationConfig;
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /roleId/i.test(e))).toBe(true);
  });

  it('errors when migrationsDir is empty', () => {
    const cfg: MigrationConfig = { engine: 'mysql', roleId: 'dbr_x', migrationsDir: '' };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /migrationsDir/i.test(e))).toBe(true);
  });

  it('errors when migrationsDir is missing', () => {
    const cfg = { engine: 'mysql', roleId: 'dbr_x' } as unknown as MigrationConfig;
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /migrationsDir/i.test(e))).toBe(true);
  });

  it('accepts a bare filename scaffoldingFile', () => {
    const cfg: MigrationConfig = {
      engine: 'mysql',
      roleId: 'dbr_x',
      migrationsDir: '/m',
      scaffoldingFile: 'migration_utils.sql',
    };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors).toEqual([]);
  });

  it('accepts an absolute path scaffoldingFile', () => {
    const cfg: MigrationConfig = {
      engine: 'mysql',
      roleId: 'dbr_x',
      migrationsDir: '/m',
      scaffoldingFile: '/abs/path/helpers.sql',
    };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors).toEqual([]);
  });

  it('rejects a relative-with-separator scaffoldingFile', () => {
    const cfg: MigrationConfig = {
      engine: 'mysql',
      roleId: 'dbr_x',
      migrationsDir: '/m',
      scaffoldingFile: 'sub/helpers.sql',
    };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });

  it('rejects an empty scaffoldingFile', () => {
    const cfg: MigrationConfig = {
      engine: 'mysql',
      roleId: 'dbr_x',
      migrationsDir: '/m',
      scaffoldingFile: '',
    };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors.some((e) => /scaffoldingFile/i.test(e))).toBe(true);
  });

  it('returns no errors for a valid mysql config', () => {
    const cfg: MigrationConfig = { engine: 'mysql', roleId: 'dbr_x', migrationsDir: '/m' };
    const { errors } = validateMigrationConfig(cfg);
    expect(errors).toEqual([]);
  });
});
