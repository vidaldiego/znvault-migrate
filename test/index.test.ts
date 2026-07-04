import { describe, it, expect } from 'vitest';
import { validateMigrationConfig, MigrationRunner, mysqlAdapter } from '../src/index.js';
import type { MigrationConfig } from '../src/index.js';

describe('public API barrel', () => {
  it('exports validateMigrationConfig as a function', () => {
    expect(typeof validateMigrationConfig).toBe('function');
  });

  it('exports MigrationRunner as a class', () => {
    expect(typeof MigrationRunner).toBe('function');
  });

  it('exports the mysql adapter intact', () => {
    expect(mysqlAdapter.engine).toBe('mysql');
    expect(typeof mysqlAdapter.openConnection).toBe('function');
  });

  it('validateMigrationConfig is live end-to-end through the barrel', () => {
    const cfg: MigrationConfig = { engine: 'mysql', roleId: 'r', migrationsDir: '/m' };
    expect(validateMigrationConfig(cfg)).toEqual({ errors: [] });
  });
});
