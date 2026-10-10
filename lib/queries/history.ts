// History series: merges intraday (live / hourly) and daily snapshots per (address, chain) slice.
// Rules:
// - Every slice carries forward its last known value (so a partially backfilled day, or a chain that
//   failed in one live snapshot, does not dip to zero). Before a slice's first point it is 0.
// - A daily point is dropped for a slice when that slice has an intraday point within the same UTC day,
//   so a day is never represented twice. Daily points are plotted at their day start (ts).
// - Output is downsampled to at most MAX_POINTS by time buckets (last, highest and lowest point of each bucket).
// - groupBy=wallet attributes an address shared by several wallets to ONE owner so the stacked layers
//   always sum to the total: the lowest wallet id among the wallets in scope (the wallet created
//   first; wallet_addresses rowids are not used because VACUUM may renumber them). Each key carries
//   the wallet's own color, else a palette color by the wallet's position in the full wallet list
//   (stable when other wallets are excluded or filtered out).
// - Every point carries assetsUsd (gross: wallet + supplied) and debtUsd (borrowed, positive). Debt
//   comes from the slice's borrow balances and is carried forward per slice exactly like total, so
//   total = assetsUsd - debtUsd holds on every point (position_values is net of debt).
// - getHistory adds unleveredUsd to every point: the unleveraged comparison line computed on the full
//   merged event timeline of lib/queries/pnl.ts (unleveredSampler), sampled at each emitted point.
import type { Chain, GroupBy, HistoryPoint, HistoryRange, HistoryResponse, Scope } from './api-types';
import { all, get, jsonIds, nowSec, type QDb } from './db';
import { CHAIN_LABELS, DAY, MAX_POINTS, PROTOCOL_LABELS, RANGE_SECONDS, WALLET_COLORS, isChain } from './meta';
import { listWallets, resolveScope, scopeToString, walletLinks } from './scope';
import { loadScopeHistory, unleveredSampler } from './pnl';
import { CHAIN_ENABLED_SQL, type SnapshotKind, loadTokens, sliceBalances, sliceKey, slicesAt, sliceValues } from './state';

export interface SeriesOptions {
  addressIds: number[];
  from: number;
  to: number;
  /** series key for a position value row, or null to count it only in total */
  groupKey: (addressId: number, chain: Chain, protocol: string) => string | null;
  maxPoints?: number;
}

interface Event {
  t: number;
  slice: string;
  values: Map<string | null, number>;
  total: number;
  /** borrowed usd of the slice, positive */
  debt: number;
  /** daily slice valued with at least one missing historical price (counted as $0) */
  partial?: boolean;
}

/** Unpriced holdings below this (at the token's latest known price) do not mark a day as partial. */
const PARTIAL_MIN_USD = 1;

/**
 * `${snapshotId}|${addressId}|${chain}` of daily slices flagged as partial price data. A flag only
 * counts when at least one unpriced token could matter: worth >= PARTIAL_MIN_USD at its latest known
 * price, or never priced at all and not spam. Dust like 1 HEX would otherwise flag every day.
 */
function partialSlices(db: QDb, addressIds: number[], from: number, to: number): Set<string> {
  if (!get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'daily_flags'")) return new Set();
  const rows = all<{ s: number; a: number; c: string }>(
    db,
    `SELECT f.snapshot_id AS s, f.address_id AS a, f.chain AS c FROM daily_flags f JOIN snapshots s ON s.id = f.snapshot_id
     WHERE f.address_id IN (SELECT value FROM json_each(?)) AND s.ts >= ? AND s.ts <= ?
       AND EXISTS (
         SELECT 1 FROM json_each(f.missing_price_keys) k
         JOIN tokens t ON t.chain = f.chain AND t.price_key = k.value
         JOIN balances b ON b.snapshot_id = f.snapshot_id AND b.address_id = f.address_id
                        AND b.chain = f.chain AND b.token = t.address
         WHERE CASE
           WHEN (SELECT p.usd FROM prices p WHERE p.price_key = k.value ORDER BY p.ts DESC LIMIT 1) IS NULL
             THEN t.spam = 0
           ELSE abs(b.amount) * (SELECT p.usd FROM prices p WHERE p.price_key = k.value ORDER BY p.ts DESC LIMIT 1) >= ${PARTIAL_MIN_USD}
         END
       )`,
    jsonIds(addressIds),
    from - DAY,
    to,
  );
  return new Set(rows.map((r) => `${r.s}|${r.a}|${r.c}`));
}

/** Earliest plotted point of the scope (same chain filter as the series and the PnL history). */
export function earliestTs(db: QDb, addressIds: number[]): number | null {
  if (!addressIds.length) return null;
  const r = get<{ m: number | null }>(
    db,
    `SELECT MIN(s.ts) AS m FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id JOIN addresses ad ON ad.id = pv.address_id
     WHERE pv.address_id IN (SELECT value FROM json_each(?)) AND pv.chain IN ('ethereum', 'arbitrum') AND ${CHAIN_ENABLED_SQL}`,
    jsonIds(addressIds),
  );
  return r?.m ?? null;
}

/** Pick the timestamps to emit: all of them, or the last one of each of maxPoints time buckets. */
export function downsample(ts: number[], maxPoints: number): Set<number> {
  if (ts.length <= maxPoints) return new Set(ts);
  const first = ts[0];
  const last = ts[ts.length - 1];
  const width = (last - first) / (maxPoints - 1);
  const keep = new Map<number, number>();
  for (const t of ts) keep.set(Math.floor((t - first) / width), t);
  const out = new Set(keep.values());
  out.add(first);
  out.add(last);
  // first + last + buckets can exceed the limit by one; drop the earliest bucket pick if so
  if (out.size > maxPoints) {
    const sorted = [...out].sort((a, b) => a - b);
    out.delete(sorted[1]);
  }
  return out;
}

/**
 * Like downsample, but keeps each bucket's highest and lowest value besides its last point, so short
 * spikes (an all-time high, a dip) survive thinning. Uses a third of the buckets to stay within maxPoints.
 */
export function downsampleExtremes(ts: number[], values: number[], maxPoints: number): Set<number> {
  if (ts.length <= maxPoints) return new Set(ts);
  const buckets = Math.max(2, Math.floor(maxPoints / 3));
  const first = ts[0];
  const width = (ts[ts.length - 1] - first) / buckets || 1;
  const pick = new Map<number, { last: number; hi: number; lo: number }>();
  for (let k = 0; k < ts.length; k++) {
    const b = Math.min(buckets - 1, Math.floor((ts[k] - first) / width));
    const cur = pick.get(b);
    if (!cur) pick.set(b, { last: k, hi: k, lo: k });
    else {
      cur.last = k;
      if (values[k] > values[cur.hi]) cur.hi = k;
      if (values[k] < values[cur.lo]) cur.lo = k;
    }
  }
  const out = new Set<number>([first, ts[ts.length - 1]]);
  for (const p of pick.values()) {
    out.add(ts[p.last]);
    out.add(ts[p.hi]);
    out.add(ts[p.lo]);
  }
  return out;
}

export function buildSeries(db: QDb, o: SeriesOptions): HistoryPoint[] {
  if (!o.addressIds.length || o.to < o.from) return [];
  const maxPoints = Math.max(2, o.maxPoints ?? MAX_POINTS);

  // seed: per slice state at `from` (daily points plotted at their day start)
  const seed = slicesAt(db, o.addressIds, o.from, 'display');
  const partial = partialSlices(db, o.addressIds, o.from, o.to);
  const state = new Map<string, { values: Map<string | null, number>; total: number; debt: number; partial?: boolean }>();
  const seedDebt = new Map<string, number>();
  for (const b of sliceBalances(db, seed)) {
    if (b.side !== 'borrow') continue;
    const k = sliceKey(b.addressId, b.chain);
    seedDebt.set(k, (seedDebt.get(k) ?? 0) + Math.abs(b.usd));
  }
  for (const r of sliceValues(db, seed)) {
    const k = sliceKey(r.addressId, r.chain);
    let s = state.get(k);
    if (!s) {
      s = { values: new Map(), total: 0, debt: seedDebt.get(k) ?? 0, partial: partial.has(`${r.snapshotId}|${r.addressId}|${r.chain}`) };
      state.set(k, s);
    }
    const g = o.groupKey(r.addressId, r.chain, r.protocol);
    s.values.set(g, (s.values.get(g) ?? 0) + r.usd);
    s.total += r.usd;
  }

  const rows = all<{ id: number; ts: number; kind: SnapshotKind; a: number; c: string; p: string; usd: number | null }>(
    db,
    `SELECT s.id AS id, s.ts AS ts, s.kind AS kind, pv.address_id AS a, pv.chain AS c, pv.protocol AS p, pv.usd AS usd
     FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id JOIN addresses ad ON ad.id = pv.address_id
     WHERE pv.address_id IN (SELECT value FROM json_each(?)) AND s.ts > ? AND s.ts <= ? AND ${CHAIN_ENABLED_SQL}
     ORDER BY s.ts, s.id`,
    jsonIds(o.addressIds),
    o.from,
    o.to,
  );

  // group into one event per (snapshot, slice)
  const events = new Map<string, Event & { kind: SnapshotKind }>();
  const intradayDays = new Map<string, Set<number>>(); // slice -> day starts that have intraday points
  for (const r of rows) {
    if (!isChain(r.c)) continue;
    const slice = sliceKey(r.a, r.c);
    const ek = `${r.id}|${slice}`;
    let e = events.get(ek);
    if (!e) {
      e = { t: r.ts, slice, values: new Map(), total: 0, debt: 0, kind: r.kind, partial: r.kind === 'daily' && partial.has(`${r.id}|${r.a}|${r.c}`) };
      events.set(ek, e);
      if (r.kind !== 'daily') {
        if (!intradayDays.has(slice)) intradayDays.set(slice, new Set());
        intradayDays.get(slice)!.add(Math.floor(r.ts / DAY) * DAY);
      }
    }
    const usd = r.usd ?? 0;
    const g = o.groupKey(r.a, r.c, r.p);
    e.values.set(g, (e.values.get(g) ?? 0) + usd);
    e.total += usd;
  }

  // borrowed usd per event (few rows: only slices with Aave debt have any); rows of slices without
  // an event (disabled chain, no position_values) are ignored like their values
  const debtRows = all<{ id: number; a: number; c: string; usd: number }>(
    db,
    `SELECT b.snapshot_id AS id, b.address_id AS a, b.chain AS c, SUM(abs(b.usd)) AS usd
     FROM balances b JOIN snapshots s ON s.id = b.snapshot_id
     WHERE b.side = 'borrow' AND b.address_id IN (SELECT value FROM json_each(?)) AND s.ts > ? AND s.ts <= ?
     GROUP BY b.snapshot_id, b.address_id, b.chain`,
    jsonIds(o.addressIds),
    o.from,
    o.to,
  );
  for (const r of debtRows) {
    const e = events.get(`${r.id}|${sliceKey(r.a, r.c)}`);
    if (e) e.debt += r.usd ?? 0;
  }

  const kept = [...events.values()]
    .filter((e) => !(e.kind === 'daily' && intradayDays.get(e.slice)?.has(e.t)))
    .sort((a, b) => a.t - b.t || (a.kind === 'daily' ? -1 : 1) - (b.kind === 'daily' ? -1 : 1));

  let i = 0;
  const timeline: number[] = [];
  if (state.size) timeline.push(o.from);
  for (let j = 0; j < kept.length; j++) if (timeline[timeline.length - 1] !== kept[j].t) timeline.push(kept[j].t);
  if (!timeline.length) return [];
  const points: HistoryPoint[] = [];
  for (const t of timeline) {
    while (i < kept.length && kept[i].t === t) {
      state.set(kept[i].slice, kept[i]);
      i++;
    }
    const series: Record<string, number> = {};
    let total = 0;
    let debtUsd = 0;
    let isPartial = false;
    for (const s of state.values()) {
      total += s.total;
      debtUsd += s.debt;
      if (s.partial) isPartial = true;
      for (const [g, v] of s.values) if (g != null) series[g] = (series[g] ?? 0) + v;
    }
    const p: HistoryPoint = { t, total, series, assetsUsd: total + debtUsd, debtUsd };
    if (isPartial) p.partial = true;
    points.push(p);
  }
  if (points.length <= maxPoints) return points;
  const emit = downsampleExtremes(
    points.map((p) => p.t),
    points.map((p) => p.total),
    maxPoints,
  );
  return points.filter((p) => emit.has(p.t));
}

export function rangeBounds(db: QDb, range: HistoryRange, addressIds: number[], now: number): { from: number; to: number } {
  if (range === 'all') return { from: earliestTs(db, addressIds) ?? now, to: now };
  return { from: now - RANGE_SECONDS[range], to: now };
}

export function getHistory(
  db: QDb,
  scope: Scope,
  range: HistoryRange,
  groupBy: GroupBy,
  now = nowSec(),
): HistoryResponse | null {
  const ids = resolveScope(db, scope);
  if (!ids) return null;
  const { from, to } = rangeBounds(db, range, ids, now);

  let groupKey: SeriesOptions['groupKey'] = () => null;
  let keys: HistoryResponse['keys'] = [];
  if (groupBy === 'chain') {
    groupKey = (_a, c) => c;
    keys = (Object.keys(CHAIN_LABELS) as Chain[]).map((c) => ({ key: c, label: CHAIN_LABELS[c], color: null }));
  } else if (groupBy === 'protocol') {
    groupKey = (_a, _c, p) => p;
    keys = Object.entries(PROTOCOL_LABELS).map(([key, label]) => ({ key, label, color: null }));
  } else if (groupBy === 'wallet') {
    const allWallets = listWallets(db);
    const paletteIdx = new Map(allWallets.map((w, i) => [w.id, i]));
    const wallets = allWallets.filter((w) => (scope.kind === 'wallet' ? w.id === scope.walletId : scope.kind === 'all' ? !w.excluded : true));
    const allowed = new Set(wallets.map((w) => w.id));
    const links = walletLinks(db);
    const owner = new Map<number, number>();
    for (const id of ids) {
      const inScope = (links.byAddress.get(id) ?? []).filter((x) => allowed.has(x.id));
      if (inScope.length) owner.set(id, Math.min(...inScope.map((x) => x.id)));
    }
    groupKey = (a) => (owner.has(a) ? String(owner.get(a)) : 'other');
    const owners = new Set(owner.values());
    keys = wallets
      .filter((w) => owners.has(w.id))
      .map((w) => ({ key: String(w.id), label: w.name, color: w.color ?? WALLET_COLORS[(paletteIdx.get(w.id) ?? 0) % WALLET_COLORS.length] }));
    if (ids.some((id) => !owner.has(id))) keys.push({ key: 'other', label: 'Other', color: null });
  }

  const points = buildSeries(db, { addressIds: ids, from, to, groupKey });
  if (points.length) {
    const unlevered = unleveredSampler(loadScopeHistory(db, ids, loadTokens(db)), points[0].t);
    for (const p of points) p.unleveredUsd = unlevered(p.t) ?? p.total;
  }
  // keep only keys that actually appear (chain / protocol), preserving order
  if (groupBy === 'chain' || groupBy === 'protocol') {
    const seen = new Set(points.flatMap((p) => Object.keys(p.series)));
    keys = keys.filter((k) => seen.has(k.key));
    for (const k of seen) if (!keys.some((x) => x.key === k)) keys.push({ key: k, label: k, color: null });
  }
  return { scope: scopeToString(scope), range, groupBy, from, to, keys, points };
}
