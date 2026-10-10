// Job and backfill progress read models.
import type { BackfillProgress, Chain, JobInfo, JobsSummary } from './api-types';
import { all, jsonIds, type QDb } from './db';
import { isChain } from './meta';

interface RawJob {
  id: number;
  type: string;
  payload: string | null;
  status: string | null;
  progress: number | null;
  total: number | null;
  error: string | null;
  created_at: number | null;
  updated_at: number | null;
}

function parsePayload(raw: string | null): unknown {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function mapJob(r: RawJob): JobInfo {
  return {
    id: r.id,
    type: r.type,
    payload: parsePayload(r.payload),
    status: r.status ?? 'pending',
    progress: r.progress,
    total: r.total,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const JOB_COLS = 'id, type, payload, status, progress, total, error, created_at, updated_at';

export function listJobs(db: QDb, limit = 50): JobInfo[] {
  return all<RawJob>(db, `SELECT ${JOB_COLS} FROM jobs ORDER BY id DESC LIMIT ?`, limit).map(mapJob);
}

export function emptyBackfill(): BackfillProgress {
  return { doneDays: 0, totalDays: 0, pct: 1, startTs: null, complete: true, chains: [], error: null };
}

/** Backfill progress per address id, from discovery_state. */
export function backfillProgress(db: QDb, addressIds: number[]): Map<number, BackfillProgress> {
  const out = new Map<number, BackfillProgress>();
  for (const id of addressIds) out.set(id, emptyBackfill());
  if (!addressIds.length) return out;
  const rows = all<{
    address_id: number;
    chain: string;
    start_block: number | null;
    start_ts: number | null;
    backfill_done_days: number | null;
    backfill_total_days: number | null;
  }>(
    db,
    `SELECT address_id, chain, start_block, start_ts, backfill_done_days, backfill_total_days FROM discovery_state
     WHERE address_id IN (SELECT value FROM json_each(?)) ORDER BY address_id, chain`,
    jsonIds(addressIds),
  );
  // per (address, chain) backfill errors written by lib/history/backfill.ts (meta history:error:<id>:<chain>)
  const errors = new Map(
    all<{ key: string; value: string }>(db, "SELECT key, value FROM meta WHERE key LIKE 'history:error:%'").map((r) => [r.key, r.value] as const),
  );
  for (const r of rows) {
    if (!isChain(r.chain)) continue;
    const p = out.get(r.address_id)!;
    const done = Math.max(0, r.backfill_done_days ?? 0);
    const total = Math.max(0, r.backfill_total_days ?? 0);
    const error = errors.get(`history:error:${r.address_id}:${r.chain}`) || null;
    if (error && !p.error) p.error = error;
    p.chains.push({ chain: r.chain as Chain, doneDays: done, totalDays: total, startTs: r.start_ts, startBlock: r.start_block, error });
    p.doneDays += Math.min(done, total);
    p.totalDays += total;
    if (r.start_ts != null && (p.startTs == null || r.start_ts < p.startTs)) p.startTs = r.start_ts;
  }
  for (const p of out.values()) {
    p.pct = p.totalDays > 0 ? p.doneDays / p.totalDays : 1;
    p.complete = p.doneDays >= p.totalDays;
  }
  return out;
}

export function jobsSummary(db: QDb, addressIds: number[]): JobsSummary {
  const counts = all<{ status: string | null; n: number }>(db, 'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
  const n = (s: string) => counts.find((c) => (c.status ?? 'pending') === s)?.n ?? 0;
  const active = all<RawJob>(
    db,
    `SELECT ${JOB_COLS} FROM jobs WHERE COALESCE(status, 'pending') IN ('pending', 'running') ORDER BY id LIMIT 50`,
  ).map(mapJob);
  let doneDays = 0;
  let totalDays = 0;
  for (const p of backfillProgress(db, addressIds).values()) {
    doneDays += p.doneDays;
    totalDays += p.totalDays;
  }
  return {
    pending: n('pending'),
    running: n('running'),
    failed: n('failed'),
    active,
    backfill: { doneDays, totalDays, pct: totalDays > 0 ? doneDays / totalDays : 1, complete: doneDays >= totalDays },
  };
}
