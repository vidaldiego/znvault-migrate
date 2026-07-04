import type { Conn } from '../engine-adapter.js';

/**
 * The MySQL adapter's concrete connection handle. Extends the engine-agnostic `Conn`
 * (query rows-directly + end) with the two MySQL-only members the ported leaf modules
 * need: the prepared-statement `execute` path (used by the schema_migrations repo to read
 * affectedRows) and the captured `connectionId` (used by the lock's IS_USED_LOCK ownership
 * check). `openConnection()` (Task 5's connection.ts) returns a MysqlConn as a `Conn`; the
 * MySQL adapter methods downcast their own `Conn` back to `MysqlConn` internally since they
 * know they created it. This keeps the public `Conn` engine-agnostic (a future PG adapter
 * needs neither `execute` nor MySQL's connectionId) while porting the repo/lock faithfully.
 */
export interface MysqlConn extends Conn {
  /**
   * Parameterized execute (prepared statement). Returns the raw mysql2 result tuple
   * [OkPacket|RowDataPacket[], FieldPacket[]] so callers can access affectedRows for
   * DML statements as well as rows for SELECT statements.
   */
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  /** The MySQL CONNECTION_ID() captured immediately after connecting. */
  connectionId: number;
}
