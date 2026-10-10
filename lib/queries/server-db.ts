// Process-wide database handle for route handlers. Opened lazily (never at import time, so
// `next build` does not need a database) and migrated on first use.
import Database from 'better-sqlite3';
import { migrate } from '../db/migrate';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { QDb } from './db';

const g = globalThis as unknown as { __portfolioQueriesDb?: Database.Database; __portfolioQueriesDbPath?: string };

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH || './data/portfolio.db');
}

export function getDb(): QDb {
  if (!g.__portfolioQueriesDb) {
    const path = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    migrate(db);
    g.__portfolioQueriesDb = db;
    g.__portfolioQueriesDbPath = path;
  }
  return g.__portfolioQueriesDb as unknown as QDb;
}
