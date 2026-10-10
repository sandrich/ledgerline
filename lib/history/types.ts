// Internal types for the history subsystem (backfill, price history, rollup).
// Kept local so lib/history does not depend on in-progress shared modules.
import type BetterSqlite3 from 'better-sqlite3';

export type Db = BetterSqlite3.Database;

export type HistoryChain = 'ethereum' | 'arbitrum';
export const HISTORY_CHAINS: HistoryChain[] = ['ethereum', 'arbitrum'];

export interface HistoryLogger {
  debug?: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

export interface HistoryJobOptions {
  db: Db;
  log: HistoryLogger;
  signal?: AbortSignal;
}

/** Native coin pseudo token address used in tokens/balances rows. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

export const DAY = 86_400;

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** UTC day start (unix seconds) for a unix-seconds timestamp. */
export function dayStart(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function isoDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function parseIsoDay(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
