// Daily price history (DefiLlama /chart) and USD->CHF FX history (Frankfurter).
// Past daily prices are immutable: stored once, never overwritten.
import {
  histDailyPriceRange,
  histEarliestStartTs,
  histFxMaxDay,
  histFxMinDay,
  histGetMeta,
  histInsertDailyPrices,
  histInsertFx,
  histInsertHourlyPrices,
  histLoadPrices,
  histListNeededPriceKeys,
  histSetMeta,
} from '../db/repos-history';
import { fetchJson } from './http';
import { ETH_KEY } from './price-keys';
import { DAY, dayStart, isoDay, mapLimit, nowSec, parseIsoDay, throwIfAborted, type HistoryJobOptions } from './types';

const LLAMA = 'https://coins.llama.fi';
const FRANKFURTER = 'https://api.frankfurter.app';
const MAX_POINTS = 500; // DefiLlama: coins x span <= 500

export interface SyncPriceHistoryOptions extends HistoryJobOptions {
  /** Price keys to cover; default: every key used by tokens of tracked addresses + Aave tokens + ETH. */
  keys?: string[];
  /** Earliest day (unix seconds) needed; default: earliest discovery_state.start_ts, else 365 days ago. */
  fromTs?: number;
  /** Also sync USD->CHF FX (default true). */
  fx?: boolean;
}

export interface SyncPriceHistoryResult {
  keys: number;
  requests: number;
  inserted: number;
  fxInserted: number;
  /** Keys with at least one failed request (their range is retried next run). */
  failedKeys: string[];
}

interface ChartResponse {
  coins?: Record<string, { prices?: { timestamp: number; price: number }[] }>;
}

/** Key in meta marking how far back a price key has been requested (so shallow series are not re-polled). */
const checkedKey = (k: string) => `pricehist:from:${k}`;
/** Key in meta holding chart spans ([start, end] day ts) whose request failed and must be retried. */
const retryKey = (k: string) => `pricehist:retry:${k}`;

function readRetry(db: SyncPriceHistoryOptions['db'], k: string): [number, number][] {
  try {
    const v = JSON.parse(histGetMeta(db, retryKey(k)) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is [number, number] => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)) : [];
  } catch {
    return [];
  }
}

export async function syncPriceHistory(opts: SyncPriceHistoryOptions): Promise<SyncPriceHistoryResult> {
  const { db, log, signal } = opts;
  const today = dayStart(nowSec());
  const from = dayStart(opts.fromTs ?? histEarliestStartTs(db) ?? today - 365 * DAY);
  const keys = [...new Set([ETH_KEY, ...(opts.keys ?? histListNeededPriceKeys(db))])].sort();

  // Build the list of (key, start, days) chart requests.
  const jobs: { key: string; start: number; span: number }[] = [];
  for (const key of keys) {
    const range = histDailyPriceRange(db, key);
    const checkedFrom = Number(histGetMeta(db, checkedKey(key)) ?? NaN);
    const segments: [number, number][] = [];
    const checked = Number.isFinite(checkedFrom);
    if (range.min == null || range.max == null) {
      // no data yet: full range the first time; afterwards only older-than-checked plus a recent tail
      if (!checked) segments.push([from, today]);
      else {
        if (from < checkedFrom) segments.push([from, checkedFrom - DAY]);
        segments.push([Math.max(from, today - 14 * DAY), today]);
      }
    } else {
      const olderEnd = Math.min(range.min, checked ? checkedFrom : range.min) - DAY;
      if (from <= olderEnd) segments.push([from, olderEnd]);
      if (range.max < today) segments.push([range.max + DAY, today]);
    }
    // spans that failed on an earlier run (inside ranges the markers above already count as covered)
    for (const [s, e] of readRetry(db, key)) if (!segments.some(([a, b]) => a <= s && e <= b)) segments.push([s, Math.min(e, today)]);
    for (const [s, e] of segments) {
      for (let t = s; t <= e; t += MAX_POINTS * DAY) {
        const span = Math.min(MAX_POINTS, Math.floor((e - t) / DAY) + 1);
        jobs.push({ key, start: t, span });
      }
    }
  }

  let inserted = 0;
  // Keys with any failed chart request: their checked-from marker is NOT advanced, so the next run
  // requests the whole uncovered range again instead of treating the failed span as "no data".
  const failedKeys = new Set<string>();
  const failedSpans = new Map<string, [number, number][]>();
  await mapLimit(jobs, 4, async (j) => {
    throwIfAborted(signal);
    // points are anchored at start + k days (a few minutes of jitter is absorbed by rounding below)
    const url = `${LLAMA}/chart/${encodeURIComponent(j.key)}?start=${j.start}&span=${j.span}&period=1d&searchWidth=600`;
    let resp: ChartResponse | null = null;
    try {
      resp = await fetchJson<ChartResponse>(url, { signal, retries: 4 });
    } catch (e) {
      if (signal?.aborted) throw e;
      failedKeys.add(j.key);
      failedSpans.set(j.key, [...(failedSpans.get(j.key) ?? []), [j.start, j.start + (j.span - 1) * DAY]]);
      log.warn(`price history request failed for ${j.key}`, { error: String(e).slice(0, 200) });
      return;
    }
    const pts = resp?.coins?.[j.key]?.prices ?? [];
    const byDay = new Map<number, number>();
    for (const p of pts) {
      if (!Number.isFinite(p.price) || p.price < 0) continue;
      const d = Math.round(p.timestamp / DAY) * DAY; // chart points sit near 00:00 UTC
      if (d > today || byDay.has(d)) continue;
      byDay.set(d, p.price);
    }
    inserted += histInsertDailyPrices(
      db,
      [...byDay].map(([ts, usd]) => ({ key: j.key, ts, usd })),
    );
  });
  for (const key of keys) {
    // every stored retry span was part of this run's jobs: replace with what failed this time
    const spans = failedSpans.get(key);
    if (spans) histSetMeta(db, retryKey(key), JSON.stringify(spans));
    else if (histGetMeta(db, retryKey(key)) != null) histSetMeta(db, retryKey(key), '[]');
    if (failedKeys.has(key)) continue;
    const prev = Number(histGetMeta(db, checkedKey(key)) ?? NaN);
    if (!Number.isFinite(prev) || from < prev) histSetMeta(db, checkedKey(key), String(from));
  }

  let fxInserted = 0;
  if (opts.fx !== false) {
    try {
      fxInserted = await syncFx(opts, from);
    } catch (e) {
      log.warn('fx history sync failed', { error: String(e).slice(0, 200) });
    }
  }
  log.info(`price history: ${keys.length} keys, ${jobs.length} requests, ${inserted} new daily prices, ${fxInserted} new fx days`, failedKeys.size ? { failedKeys: [...failedKeys] } : undefined);
  return { keys: keys.length, requests: jobs.length, inserted, fxInserted, failedKeys: [...failedKeys] };
}

/** USD->CHF daily from Frankfurter (business days), forward-filled to every calendar day up to the last published day. */
export async function syncFx(opts: HistoryJobOptions, fromTs: number): Promise<number> {
  const { db, signal } = opts;
  const today = dayStart(nowSec());
  const maxDay = histFxMaxDay(db);
  const minDay = histFxMinDay(db);
  const ranges: [number, number][] = [];
  if (!minDay || parseIsoDay(minDay) > fromTs) ranges.push([fromTs - 7 * DAY, minDay ? parseIsoDay(minDay) - DAY : today]);
  if (maxDay && parseIsoDay(maxDay) < today) ranges.push([parseIsoDay(maxDay) - 7 * DAY, today]);
  let inserted = 0;
  for (const [s, e] of ranges) {
    const j = await fetchJson<{ rates?: Record<string, { CHF?: number }> }>(`${FRANKFURTER}/${isoDay(s)}..${isoDay(e)}?from=USD&to=CHF`, {
      signal,
      retries: 4,
    });
    const published = Object.entries(j?.rates ?? {})
      .filter(([, v]) => typeof v.CHF === 'number')
      .map(([d, v]) => [parseIsoDay(d), v.CHF as number] as const)
      .sort((a, b) => a[0] - b[0]);
    if (!published.length) continue;
    const rows: { day: string; usdChf: number }[] = [];
    let idx = 0;
    let last: number | null = null;
    for (let d = published[0][0]; d <= published[published.length - 1][0]; d += DAY) {
      while (idx < published.length && published[idx][0] <= d) last = published[idx++][1];
      if (last != null && d >= fromTs - 7 * DAY) rows.push({ day: isoDay(d), usdChf: last });
    }
    inserted += histInsertFx(db, rows);
  }
  return inserted;
}

/** Valuation price for the END of day `dayTs`: next midnight's daily price, falling back up to 7 days earlier. */
export function priceForDayEnd(series: Map<number, number> | undefined, dayTs: number): number | null {
  if (!series || series.size === 0) return null;
  for (let d = dayTs + DAY; d >= dayTs - 7 * DAY; d -= DAY) {
    const v = series.get(d);
    if (v != null) return v;
  }
  return null;
}

const HOUR = 3600;

export interface SyncHourlyPricesOptions extends HistoryJobOptions {
  keys: string[];
  /** First and last UTC hour start (inclusive) needed. */
  fromTs: number;
  toTs: number;
}

/**
 * Hourly prices (DefiLlama /chart period=1h, points at exact UTC hour starts) for [fromTs, toTs],
 * stored as granularity 'hourly' (immutable). Only keys missing any hour of the window are
 * requested; several keys share one request within the coins x span <= 500 limit.
 */
export async function syncHourlyPrices(opts: SyncHourlyPricesOptions): Promise<{ requests: number; inserted: number; failedKeys: string[] }> {
  const { db, log, signal } = opts;
  const from = Math.floor(opts.fromTs / HOUR) * HOUR;
  const to = Math.floor(opts.toTs / HOUR) * HOUR;
  const hours = Math.round((to - from) / HOUR) + 1;
  const have = histLoadPrices(db, opts.keys, 'hourly', from, to);
  const keys = [...new Set(opts.keys)].filter((k) => (have.get(k)?.size ?? 0) < hours).sort();
  const jobs: { keys: string[]; start: number; span: number }[] = [];
  for (let t = from; t <= to; t += MAX_POINTS * HOUR) {
    const span = Math.min(MAX_POINTS, Math.round((to - t) / HOUR) + 1);
    const perReq = Math.max(1, Math.floor(MAX_POINTS / span));
    for (let i = 0; i < keys.length; i += perReq) jobs.push({ keys: keys.slice(i, i + perReq), start: t, span });
  }
  let inserted = 0;
  const failed = new Set<string>();
  await mapLimit(jobs, 4, async (j) => {
    throwIfAborted(signal);
    const url = `${LLAMA}/chart/${j.keys.map(encodeURIComponent).join(',')}?start=${j.start}&span=${j.span}&period=1h&searchWidth=600`;
    let resp: ChartResponse | null = null;
    try {
      resp = await fetchJson<ChartResponse>(url, { signal, retries: 4 });
    } catch (e) {
      if (signal?.aborted) throw e;
      for (const k of j.keys) failed.add(k);
      log.warn(`hourly price request failed for ${j.keys.join(',')}`, { error: String(e).slice(0, 200) });
      return;
    }
    const rows: { key: string; ts: number; usd: number }[] = [];
    for (const key of j.keys) {
      const seen = new Set<number>();
      for (const p of resp?.coins?.[key]?.prices ?? []) {
        if (!Number.isFinite(p.price) || p.price < 0) continue;
        const h = Math.round(p.timestamp / HOUR) * HOUR;
        if (h < from || h > to || seen.has(h)) continue;
        seen.add(h);
        rows.push({ key, ts: h, usd: p.price });
      }
    }
    inserted += histInsertHourlyPrices(db, rows);
  });
  log.info(`hourly prices: ${keys.length} keys, ${jobs.length} requests, ${inserted} new hourly prices`, failed.size ? { failedKeys: [...failed] } : undefined);
  return { requests: jobs.length, inserted, failedKeys: [...failed] };
}
