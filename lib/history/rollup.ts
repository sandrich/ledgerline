// Retention / rollup: raw live snapshots kept RETENTION_RAW_DAYS, hourly rollup kept
// RETENTION_HOURLY_DAYS, daily forever. Daily point for a past day = backfill value if present,
// otherwise the last live (or hourly) snapshot of that day. Idempotent: safe to run every hour.
import {
  histCopySlice,
  histDeleteHourlyPricesBefore,
  histDeleteLivePricesBefore,
  histDeleteSnapshots,
  histGetOrCreateSnapshot,
  histSnapshotPairs,
  histSnapshotsBefore,
  type SnapshotKind,
} from '../db/repos-history';
import { marketsForChain } from './aave';
import { DAY, dayStart, nowSec, type HistoryChain, type HistoryJobOptions } from './types';

const HOUR = 3600;

export interface RunRollupOptions extends HistoryJobOptions {
  now?: number;
  rawDays?: number;
  hourlyDays?: number;
}

export interface RollupResult {
  dailyFilled: number;
  hourlyFilled: number;
  liveDeleted: number;
  hourlyDeleted: number;
  livePricesDeleted: number;
  hourlyPricesDeleted: number;
}

function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

function chainMarkets(chain: string): string[] {
  return chain === 'ethereum' || chain === 'arbitrum' ? marketsForChain(chain as HistoryChain).map((m) => m.key) : [];
}

/**
 * Copy (address, chain) slices from `sources` (any order) into the target snapshot, newest source
 * first so the last value of the bucket wins. Returns slices copied.
 */
function fillTarget(opts: HistoryJobOptions, kind: SnapshotKind, ts: number, sources: { id: number; ts: number }[]): number {
  const { db } = opts;
  const sorted = [...sources].sort((a, b) => b.ts - a.ts);
  let copied = 0;
  db.transaction(() => {
    let target: number | null = null;
    for (const s of sorted) {
      for (const p of histSnapshotPairs(db, s.id)) {
        target ??= histGetOrCreateSnapshot(db, kind, ts);
        if (histCopySlice(db, s.id, target, p.address_id, p.chain, chainMarkets(p.chain))) copied++;
      }
    }
  })();
  return copied;
}

function groupBy(snaps: { id: number; ts: number }[], size: number): Map<number, { id: number; ts: number }[]> {
  const m = new Map<number, { id: number; ts: number }[]>();
  for (const s of snaps) {
    const k = Math.floor(s.ts / size) * size;
    const arr = m.get(k);
    if (arr) arr.push(s);
    else m.set(k, [s]);
  }
  return m;
}

export async function runRollup(opts: RunRollupOptions): Promise<RollupResult> {
  const { db, log } = opts;
  const now = opts.now ?? nowSec();
  const today = dayStart(now);
  const rawCutoff = now - (opts.rawDays ?? envInt('RETENTION_RAW_DAYS', 30)) * DAY;
  const hourlyCutoff = now - (opts.hourlyDays ?? envInt('RETENTION_HOURLY_DAYS', 365)) * DAY;
  const r: RollupResult = { dailyFilled: 0, hourlyFilled: 0, liveDeleted: 0, hourlyDeleted: 0, livePricesDeleted: 0, hourlyPricesDeleted: 0 };

  // 1. Daily points for completed days that the backfill has not written (last live snapshot of the day).
  const liveCompleted = histSnapshotsBefore(db, 'live', today);
  for (const [d, snaps] of groupBy(liveCompleted, DAY)) r.dailyFilled += fillTarget(opts, 'daily', d, snaps);

  // 2. Hourly rollup for live snapshots leaving the raw window, then drop them.
  const liveOld = histSnapshotsBefore(db, 'live', rawCutoff);
  for (const [h, snaps] of groupBy(liveOld, HOUR)) {
    if (h + HOUR > rawCutoff) continue; // only whole hours that are entirely past the cutoff
    r.hourlyFilled += fillTarget(opts, 'hourly', h, snaps);
  }
  const liveDrop = liveOld.filter((s) => Math.floor(s.ts / HOUR) * HOUR + HOUR <= rawCutoff).map((s) => s.id);
  histDeleteSnapshots(db, liveDrop);
  r.liveDeleted = liveDrop.length;

  // 3. Hourly snapshots leaving the hourly window: make sure their day has a daily point, then drop.
  const hourlyOld = histSnapshotsBefore(db, 'hourly', hourlyCutoff);
  for (const [d, snaps] of groupBy(hourlyOld, DAY)) {
    if (d >= today) continue;
    r.dailyFilled += fillTarget(opts, 'daily', d, snaps);
  }
  histDeleteSnapshots(
    db,
    hourlyOld.filter((s) => dayStart(s.ts) < today).map((s) => s.id),
  );
  r.hourlyDeleted = hourlyOld.length;

  // 4. Live prices: daily series covers older ranges. Hourly prices (hourly backfill) follow the
  //    hourly snapshot retention.
  r.livePricesDeleted = histDeleteLivePricesBefore(db, rawCutoff);
  r.hourlyPricesDeleted = histDeleteHourlyPricesBefore(db, hourlyCutoff);

  if (r.dailyFilled || r.hourlyFilled || r.liveDeleted || r.hourlyDeleted) log.info('rollup', { ...r });
  return r;
}
