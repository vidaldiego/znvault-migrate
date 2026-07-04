export interface MigrationFile { version: string; prefix: string; path: string; }

export interface MigrationRow {
  version: string;
  checksum: string;
  checksumAlgo: string;
  success: boolean;
  baselined: boolean;
}

export interface MigrationPlan {
  applied: MigrationFile[];
  reconcile: MigrationFile[];
  pending: MigrationFile[];
}

export interface RunResult {
  seeded: number;
  reconciled: number;
  applied: number;
  pendingRemaining: number;
}
