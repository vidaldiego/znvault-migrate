export interface FailedMigrationChecksumRepair {
  version: string;
  oldChecksum: string;
  newChecksum: string;
  reason: string;
}

/**
 * Exact, one-time repairs for rows that are both failed and non-baselined.
 * Successful migration history remains immutable.
 */
export const APPROVED_FAILED_MIGRATION_CHECKSUM_REPAIRS: readonly FailedMigrationChecksumRepair[] = [
  {
    version: '2026-09-18_001_compact-invoice-summary.sql',
    oldChecksum: '3b274a7d44a61ede04afae8926dff54d358a507777da90c726920568168ce57c',
    newChecksum: 'f5a0359ee534635f52504d12a8eeac378d32b163d4820b8082d772d07b4a4165',
    reason: 'Replace the failed migration that referenced the nonexistent _printable_style.draft_definition column',
  },
  {
    version: '2026-10-09_002_partner_sandbox_public_origin.sql',
    oldChecksum: '9d063c4a327c73e352fdf340ff4c33c47225f13404a3745fa0fd66e354587926',
    newChecksum: '33dc3d7fb7d076200c874e187bd121eb3adafd4c799e2fdcfc5e11059d2a2337',
    reason: 'Recover the failed sandbox origin cutover with stable guarded DDL and assertion-first online reconciliation',
  },
];
