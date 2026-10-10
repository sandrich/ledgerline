// Price series, FX, health, jobs list.
import { statSync } from 'node:fs';
import type { FxResponse, HealthResponse, HistoryRange, JobsResponse, PricesResponse } from './api-types';
import { all, get, jsonIds, nowSec, type QDb } from './db';
import { backfillProgress, emptyBackfill, jobsSummary, listJobs } from './jobs';
import { DAY, MAX_POINTS, RANGE_SECONDS } from './meta';
import { downsample } from './history';
import { listAddresses, overallAddressIds } from './scope';

/** Price series per key: daily points, plus live points newer than the last daily day. */
export function getPriceSeries(db: QDb, keys: string[], range: HistoryRange, now = nowSec()): PricesResponse {
  const from = range === 'all' ? 0 : now - RANGE_SECONDS[range];
  const series: PricesResponse['series'] = {};
  for (const k of keys) series[k] = [];
  if (!keys.length) return { range, series };
  const rows = all<{ k: string; ts: number; usd: number; g: string }>(
    db,
    `SELECT price_key AS k, ts, usd, granularity AS g FROM prices
     WHERE price_key IN (SELECT value FROM json_each(?)) AND ts >= ? AND ts <= ? ORDER BY ts`,
    jsonIds(keys),
    from - DAY,
    now,
  );
  const byKey = new Map<string, { daily: { t: number; usd: number }[]; live: { t: number; usd: number }[] }>();
  for (const r of rows) {
    if (r.usd == null) continue;
    let e = byKey.get(r.k);
    if (!e) {
      e = { daily: [], live: [] };
      byKey.set(r.k, e);
    }
    (r.g === 'daily' ? e.daily : e.live).push({ t: r.ts, usd: r.usd });
  }
  const shortRange = range === '24h' || range === '7d' || range === '30d';
  for (const [k, e] of byKey) {
    let pts: { t: number; usd: number }[];
    if (shortRange && e.live.length) {
      // live points where they exist, daily points before the first live point
      const firstLive = e.live[0].t;
      pts = [...e.daily.filter((p) => p.t < firstLive && p.t >= from), ...e.live];
    } else {
      const lastDaily = e.daily.length ? e.daily[e.daily.length - 1].t : -Infinity;
      pts = [...e.daily.filter((p) => p.t >= from), ...e.live.filter((p) => p.t >= lastDaily + DAY)];
    }
    pts.sort((a, b) => a.t - b.t);
    const keep = downsample(
      pts.map((p) => p.t),
      MAX_POINTS,
    );
    series[k] = pts.filter((p) => keep.has(p.t));
  }
  return { range, series };
}

export function getFx(db: QDb): FxResponse {
  const rows = all<{ day: string; usd_chf: number }>(db, 'SELECT day, usd_chf FROM fx ORDER BY day');
  const daily: Record<string, number> = {};
  for (const r of rows) if (r.usd_chf != null) daily[r.day] = r.usd_chf;
  const last = rows.length ? rows[rows.length - 1] : null;
  return { latest: last ? { day: last.day, usdChf: last.usd_chf } : null, daily };
}

const HEARTBEAT_KEYS = ['worker_heartbeat', 'worker.heartbeat', 'workerHeartbeatAt', 'heartbeat'];

function parseTs(v: string | undefined | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n); // tolerate ms
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.floor(d / 1000) : null;
}

export function getHealth(db: QDb, dbPath: string | null): HealthResponse {
  const last = get<{ m: number | null }>(db, "SELECT MAX(ts) AS m FROM snapshots WHERE kind = 'live'")?.m ?? null;
  let hb: number | null = null;
  for (const k of HEARTBEAT_KEYS) {
    const r = get<{ value: string | null }>(db, 'SELECT value FROM meta WHERE key = ?', k);
    if (r?.value != null) {
      hb = parseTs(r.value);
      if (hb != null) break;
    }
  }
  let size = 0;
  if (dbPath) {
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        size += statSync(p).size;
      } catch {
        /* missing file */
      }
    }
  }
  return { ok: true, lastSnapshotAt: last, workerHeartbeatAt: hb, dbSizeBytes: size };
}

export function getJobs(db: QDb): JobsResponse {
  const addresses = listAddresses(db);
  const progress = backfillProgress(
    db,
    addresses.map((a) => a.id),
  );
  return {
    jobs: listJobs(db, 50),
    summary: jobsSummary(db, overallAddressIds(db)),
    addresses: addresses.map((a) => ({ id: a.id, address: a.address, label: a.label, backfill: progress.get(a.id) ?? emptyBackfill() })),
  };
}
