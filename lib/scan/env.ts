// Env + database bootstrap shared by the worker and the scan scripts.
// Migration prefers lib/db/migrate.ts, falling back to the scratch schema (lib/history/dev-schema.sql).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../history/types';
import type { Logger } from './log';

export const ROOT = process.cwd();

export function loadEnv(): void {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  try {
    process.loadEnvFile(f);
  } catch {
    /* malformed .env: ignore, real env still applies */
  }
}

export function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export function databasePath(): string {
  return path.resolve(ROOT, process.env.DATABASE_PATH ?? './data/portfolio.db');
}

export function openDb(file = databasePath()): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Run the real migrations if present, else apply lib/history/dev-schema.sql (IF NOT EXISTS only). */
export async function migrateDb(db: Db, log: Logger): Promise<void> {
  const candidates = ['lib/db/migrate.ts', 'lib/db/migrate.js'].map((p) => path.join(ROOT, p));
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    const mod = (await import(c)) as Record<string, unknown>;
    const fn = (mod.migrate ?? mod.runMigrations ?? mod.default) as ((db: Db) => unknown) | undefined;
    if (typeof fn === 'function') {
      await fn(db);
      return;
    }
  }
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='snapshots'").get();
  if (!has) {
    log.warn('lib/db/migrate not found: applying lib/history/dev-schema.sql (scratch schema)');
    db.exec(fs.readFileSync(path.join(ROOT, 'lib/history/dev-schema.sql'), 'utf8'));
  }
}
