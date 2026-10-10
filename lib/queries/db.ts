// Minimal database interface used by lib/queries and lib/db/repos-api.
// Both better-sqlite3 (runtime) and node:sqlite DatabaseSync (tests) satisfy it, so the read models
// are pure functions of (db, args) and can be tested against a temp database.
// Conventions (shared with lib/history and lib/db/repos-history.ts):
// - all timestamps are unix SECONDS
// - daily snapshots use ts = UTC day start and hold the state at the END of that day
// - balances.usd is already negative for borrows; balances.amount is always positive
// - position_values.protocol is 'wallet' or 'aave-v3' and a 'wallet' row is always written per slice

export interface QStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface QDb {
  prepare(sql: string): QStatement;
  exec(sql: string): unknown;
}

/** Run fn inside BEGIN IMMEDIATE / COMMIT (works on both drivers). */
export function tx<T>(db: QDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}

export function all<T>(db: QDb, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T>(db: QDb, sql: string, ...params: unknown[]): T | undefined {
  return (db.prepare(sql).get(...params) as T | undefined) ?? undefined;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** JSON array parameter for `IN (SELECT value FROM json_each(?))`. */
export function jsonIds(ids: readonly (number | string)[]): string {
  return JSON.stringify(ids);
}
