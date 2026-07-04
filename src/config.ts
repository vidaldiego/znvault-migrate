// Path: znvault-migrate/src/config.ts
import { isAbsolute } from 'node:path';

/**
 * Configuration for a single migration phase (pre or post deploy).
 *
 * Mirrors the plugin's `MigrationConfig` shape (`znvault-plugin-payara/src/cli/types.ts`)
 * plus the `engine` discriminator, which is new to this package (§5 of the
 * znvault-migrate shared-library design).
 */
export interface MigrationConfig {
  /**
   * REQUIRED discriminator. Only 'mysql' is supported by this project; 'postgres' is
   * accepted by the type for forward-compat but rejected at validation until a
   * PostgreSQL adapter ships (see the znvault-migrate PostgreSQL design, §11).
   */
  engine: 'mysql' | 'postgres';
  /** dynamic-secrets role (lease-only; NO raw creds). */
  roleId: string;
  /** Override if the lease doesn't pin one. */
  database?: string;
  /** Absolute path to the directory of migration files. */
  migrationsDir: string;
  /** Bare filename (relative to migrationsDir) OR an absolute path; MySQL-only. */
  scaffoldingFile?: string;
}

/**
 * Validate a {@link MigrationConfig}. Pure, synchronous, no I/O.
 *
 * Ports the plugin's `validateMigrationBlock`
 * (`znvault-plugin-payara/src/cli/deploy-config-validate.ts:16-42`) for the
 * `roleId`/`migrationsDir`/`scaffoldingFile` rules, and adds the `engine`
 * discriminator rules that are new to this package (spec §5).
 */
export function validateMigrationConfig(cfg: MigrationConfig): { errors: string[] } {
  const errors: string[] = [];

  const engine = (cfg as { engine?: unknown }).engine;
  if (engine !== 'mysql' && engine !== 'postgres') {
    errors.push("engine is required and must be 'mysql' or 'postgres'.");
  } else if (engine === 'postgres') {
    errors.push(
      'postgres migrations are not yet supported (the PostgreSQL adapter is a deferred project — see the znvault-migrate PostgreSQL design)',
    );
  }

  if (!cfg.roleId || cfg.roleId.trim() === '') {
    errors.push('roleId is required (the dynamic-secrets write role).');
  }

  if (!cfg.migrationsDir || cfg.migrationsDir.trim() === '') {
    errors.push('migrationsDir is required.');
  }

  if (cfg.scaffoldingFile !== undefined) {
    if (typeof cfg.scaffoldingFile !== 'string' || cfg.scaffoldingFile.length === 0) {
      errors.push('scaffoldingFile must be a non-empty filename or absolute path.');
    } else if (
      !isAbsolute(cfg.scaffoldingFile) &&
      (cfg.scaffoldingFile.includes('/') || cfg.scaffoldingFile.includes('\\'))
    ) {
      errors.push(
        'scaffoldingFile must be a bare filename (relative to migrationsDir) or an absolute path — a relative path with separators is not allowed.',
      );
    }
  }

  return { errors };
}
