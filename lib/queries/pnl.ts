// Holdings-based PnL and all-time high for a set of addresses.
//
// Events are the same merged history points the chart uses (lib/queries/history.ts): every
// (snapshot, address, chain) slice with position_values, live / hourly / daily, where a daily point
// is dropped for a slice that has an intraday point on the same UTC day. Each slice carries its
// state forward until its next event, so between two consecutive events of one slice its amounts are
// constant and the per-chart-point sum telescopes to one segment per pair of consecutive slice events:
//
//   segment pnl = sum over rows held at e0 of sign x amount_e0 x (price_e1 - price_e0)
//
// sign is -1 for debt rows (side 'borrow'), aTokens / debt tokens use the underlying's canonical
// key. price_e0 is the price the row was valued with (|usd| / amount, so pnl and the chart agree
// exactly); price_e1 is the implied price of the same key in the slice at e1, else the nearest stored
// price at or before e1's effective time (daily snapshots hold the end-of-day state valued at the
// next day start, so their effective time is ts + 1 day). Rows without a price (usd = 0, spam tokens)
// contribute 0, as does a key that has no price at e1. Everything else in the value change (deposits,
// withdrawals, transfers between tracked addresses, Aave interest, fees) is otherUsd.
//
// returnPct is the return on invested capital: pnlUsd / (startUsd + peak cumulative net deposits in
// the window), where the net deposit at a chart point is its value change minus its PnL (internal
// transfers net out because both slices change at the same point). Without deposits it equals
// pnlUsd / startUsd; with them a $376 start followed by a $19k deposit reads as ~+93%, not +4'800%.
// Re-depositing what was withdrawn earlier in the window does not count as new capital. A time
// weighted return was rejected: periods holding only dust dominate it (1y read -4% on +$18k PnL).
import type { Chain, PnlPeriod, PnlSummary, PnlWindow } from './api-types';
import { all, jsonIds, type QDb } from './db';
import { DAY, RANGE_SECONDS, assetOf, assetSymbol, isChain } from './meta';
import { CHAIN_ENABLED_SQL, KIND_RANK, type SnapshotKind, type TokenMap, canonicalKey, sliceKey, tokenMeta } from './state';

export const PNL_WINDOWS: PnlWindow[] = ['24h', '7d', '30d', '90d', '1y', 'all'];

interface Row {
  key: string;
  asset: string;
  symbol: string;
  sign: 1 | -1;
  amount: number;
  /** implied price |usd| / amount; 0 when the row was valued without a price */
  price: number;
}

interface SliceEvent {
  snapshotId: number;
  /** plotted time (daily at its day start) */
  t: number;
  /** time the state was valued at (daily: ts + 1 day) */
  eff: number;
  kind: SnapshotKind;
  /** net usd of the slice (position_values) */
  usd: number;
  rows: Row[];
  /** implied price per key among rows that had one; keys present with usd = 0 map to 0 */
  prices: Map<string, number>;
}

interface Segment {
  pnl: number;
  byAsset: Map<string, number>;
}

interface SliceHistory {
  events: SliceEvent[];
  /** segments[i] goes from events[i] to events[i + 1] */
  segments: Segment[];
  /** prefix[i] = sum of segments[0..i-1].pnl */
  prefix: number[];
}

export interface ScopeHistory {
  slices: Map<string, SliceHistory>;
  /** earliest event time (plotted), null without history */
  earliest: number | null;
  symbols: Map<string, string>;
  /** merged net worth series (one entry per distinct event time) with the PnL realised at each point */
  points: { t: number; total: number; pnl: number; before: number }[];
}

/** Price series per key, loaded lazily (all granularities), for keys not held at the later event. */
class PriceBook {
  private series = new Map<string, { ts: number[]; usd: number[] }>();
  constructor(private db: QDb) {}

  at(key: string, t: number): number | null {
    let s = this.series.get(key);
    if (!s) {
      const rows = all<{ ts: number; usd: number; g: string }>(
        this.db,
        `SELECT ts, usd, granularity AS g FROM prices WHERE price_key = ? AND usd > 0 ORDER BY ts,
           CASE granularity WHEN 'daily' THEN 1 WHEN 'hourly' THEN 2 ELSE 3 END`,
        key,
      );
      s = { ts: rows.map((r) => r.ts), usd: rows.map((r) => r.usd) };
      this.series.set(key, s);
    }
    // last index with ts <= t (ties: the finest granularity sorts last)
    let lo = 0;
    let hi = s.ts.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.ts[mid] <= t) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best >= 0 ? s.usd[best] : null;
  }
}

function symbolFor(tokens: TokenMap, chain: Chain, token: string): string | null {
  const t = tokenMeta(tokens, chain, token);
  if (t?.underlying) {
    const u = tokenMeta(tokens, chain, t.underlying);
    if (u?.symbol) return u.symbol;
  }
  return t?.symbol ?? null;
}

/** Load every merged history event of the scope with its priced rows and precompute segment PnL. */
export function loadScopeHistory(db: QDb, addressIds: number[], tokens: TokenMap): ScopeHistory {
  const out: ScopeHistory = { slices: new Map(), earliest: null, symbols: new Map(), points: [] };
  if (!addressIds.length) return out;
  const ids = jsonIds(addressIds);

  const evRows = all<{ id: number; ts: number; kind: SnapshotKind; a: number; c: string; usd: number | null }>(
    db,
    `SELECT s.id AS id, s.ts AS ts, s.kind AS kind, pv.address_id AS a, pv.chain AS c, SUM(pv.usd) AS usd
     FROM position_values pv JOIN snapshots s ON s.id = pv.snapshot_id JOIN addresses ad ON ad.id = pv.address_id
     WHERE pv.address_id IN (SELECT value FROM json_each(?)) AND ${CHAIN_ENABLED_SQL}
     GROUP BY s.id, pv.address_id, pv.chain`,
    ids,
  );
  const intraday = new Set<string>(); // `${slice}|${dayStart}`
  for (const r of evRows) if (r.kind !== 'daily') intraday.add(`${sliceKey(r.a, r.c)}|${Math.floor(r.ts / DAY) * DAY}`);
  const events = new Map<string, SliceEvent>(); // `${snapshotId}|${slice}`
  for (const r of evRows) {
    if (!isChain(r.c)) continue;
    const slice = sliceKey(r.a, r.c);
    if (r.kind === 'daily' && intraday.has(`${slice}|${r.ts}`)) continue;
    const e: SliceEvent = {
      snapshotId: r.id,
      t: r.ts,
      eff: r.kind === 'daily' ? r.ts + DAY : r.ts,
      kind: r.kind,
      usd: r.usd ?? 0,
      rows: [],
      prices: new Map(),
    };
    events.set(`${r.id}|${slice}`, e);
    let sh = out.slices.get(slice);
    if (!sh) {
      sh = { events: [], segments: [], prefix: [] };
      out.slices.set(slice, sh);
    }
    sh.events.push(e);
  }

  const balRows = all<{ s: number; a: number; c: string; token: string; amount: number | null; usd: number | null; side: string | null }>(
    db,
    `SELECT snapshot_id AS s, address_id AS a, chain AS c, token, amount, usd, side FROM balances
     WHERE address_id IN (SELECT value FROM json_each(?)) AND amount IS NOT NULL AND amount <> 0`,
    ids,
  );
  for (const b of balRows) {
    if (!isChain(b.c)) continue;
    const e = events.get(`${b.s}|${sliceKey(b.a, b.c)}`);
    if (!e) continue;
    const token = b.token.toLowerCase();
    const meta = tokenMeta(tokens, b.c, token);
    const key = canonicalKey(tokens, b.c, token);
    const amount = Math.abs(b.amount ?? 0);
    const usd = Math.abs(b.usd ?? 0);
    const price = meta?.spam || amount === 0 ? 0 : usd / amount;
    if (price > 0) e.prices.set(key, price);
    else if (!e.prices.has(key)) e.prices.set(key, 0);
    if (price <= 0) continue;
    const symbol = symbolFor(tokens, b.c, token) ?? key;
    const asset = assetOf(key, symbol);
    if (!out.symbols.has(asset)) out.symbols.set(asset, assetSymbol(asset, symbol));
    e.rows.push({ key, asset, symbol, sign: b.side === 'borrow' ? -1 : 1, amount, price });
  }

  const book = new PriceBook(db);
  for (const sh of out.slices.values()) {
    sh.events.sort((x, y) => x.t - y.t || KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.snapshotId - y.snapshotId);
    sh.prefix.push(0);
    for (let i = 0; i + 1 < sh.events.length; i++) {
      const e0 = sh.events[i];
      const e1 = sh.events[i + 1];
      const seg: Segment = { pnl: 0, byAsset: new Map() };
      for (const r of e0.rows) {
        let p1 = e1.prices.get(r.key);
        if (p1 === undefined) p1 = book.at(r.key, e1.eff) ?? 0;
        if (!(p1 > 0)) continue;
        const v = r.sign * r.amount * (p1 - r.price);
        if (v === 0) continue;
        seg.pnl += v;
        seg.byAsset.set(r.asset, (seg.byAsset.get(r.asset) ?? 0) + v);
      }
      sh.segments.push(seg);
      sh.prefix.push(sh.prefix[i] + seg.pnl);
    }
    const first = sh.events[0]?.t;
    if (first != null && (out.earliest == null || first < out.earliest)) out.earliest = first;
  }
  out.points = mergedPoints(out);
  return out;
}

/** Global series: apply every slice event in chart order; a segment's PnL is realised at its end event. */
function mergedPoints(h: ScopeHistory): ScopeHistory['points'] {
  const evs: { t: number; rank: number; slice: string; usd: number; pnl: number }[] = [];
  for (const [slice, sh] of h.slices) {
    sh.events.forEach((e, i) => evs.push({ t: e.t, rank: KIND_RANK[e.kind], slice, usd: e.usd, pnl: i > 0 ? sh.segments[i - 1].pnl : 0 }));
  }
  evs.sort((x, y) => x.t - y.t || x.rank - y.rank);
  const cur = new Map<string, number>();
  const points: ScopeHistory['points'] = [];
  let total = 0;
  let before = 0;
  let pnl = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    total += e.usd - (cur.get(e.slice) ?? 0);
    cur.set(e.slice, e.usd);
    pnl += e.pnl;
    if (i + 1 < evs.length && evs[i + 1].t === e.t) continue;
    points.push({ t: e.t, total, pnl, before });
    before = total;
    pnl = 0;
  }
  return points;
}

/** startUsd + the peak of cumulative net deposits over points in (from, to]. */
function investedCapital(h: ScopeHistory, startUsd: number, from: number, to: number): number {
  let cum = 0;
  let peak = 0;
  for (const p of h.points) {
    if (p.t <= from) continue;
    if (p.t > to) break;
    cum += p.total - p.before - p.pnl;
    if (cum > peak) peak = cum;
  }
  return startUsd + peak;
}

/** Index of the last event with t <= at, -1 if none. */
function lastAtOrBefore(events: SliceEvent[], at: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= at) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** PnL for one window [from, to] (to defaults to the latest event). */
export function pnlPeriod(h: ScopeHistory, window: PnlWindow, from: number, to = Infinity): PnlPeriod {
  let startUsd = 0;
  let endUsd = 0;
  let pnl = 0;
  let seeded = false;
  let firstIn: number | null = null;
  const byAsset = new Map<string, number>();
  for (const sh of h.slices.values()) {
    const n = Number.isFinite(to) ? lastAtOrBefore(sh.events, to) + 1 : sh.events.length;
    if (!n) continue;
    endUsd += sh.events[n - 1].usd;
    const seed = lastAtOrBefore(sh.events, from);
    if (seed >= 0) {
      seeded = true;
      startUsd += sh.events[seed].usd;
    } else if (firstIn == null || sh.events[0].t < firstIn) firstIn = sh.events[0].t;
    const start = Math.max(seed, 0);
    pnl += sh.prefix[n - 1] - sh.prefix[start];
    for (let i = start; i < n - 1; i++) for (const [a, v] of sh.segments[i].byAsset) byAsset.set(a, (byAsset.get(a) ?? 0) + v);
  }
  const fromTs = seeded ? from : firstIn;
  if (fromTs == null) {
    return { window, fromTs: null, startUsd: null, endUsd, changeUsd: null, pnlUsd: null, returnPct: null, otherUsd: null, byAsset: [] };
  }
  const changeUsd = endUsd - startUsd;
  const capital = investedCapital(h, startUsd, from, to);
  return {
    window,
    fromTs,
    startUsd,
    endUsd,
    changeUsd,
    pnlUsd: pnl,
    // dust capital (e.g. $0.0008 before the first deposit) gives a meaningless percentage
    returnPct: capital >= 1 ? pnl / capital : null,
    otherUsd: changeUsd - pnl,
    byAsset: [...byAsset]
      .filter(([, v]) => Math.abs(v) >= 0.005)
      .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
      .slice(0, 5)
      .map(([asset, v]) => ({ asset, symbol: h.symbols.get(asset) ?? asset, pnlUsd: v })),
  };
}

/**
 * One period per history range pill (PNL_WINDOWS = HistoryRange). Like the chart, a window starts at
 * now - range, or at the scope's first history point when the history starts later ('all' always
 * does), so fromTs / startUsd / endUsd are the first and last point of the chart for that range.
 */
export function pnlSummary(h: ScopeHistory, now: number): PnlSummary {
  const out = {} as PnlSummary;
  for (const w of PNL_WINDOWS) {
    const from = w === 'all' ? (h.earliest ?? now) : Math.max(now - RANGE_SECONDS[w], h.earliest ?? -Infinity);
    out[w] = pnlPeriod(h, w, from);
  }
  return out;
}

/** All-time high of the merged net worth series (every event, no downsampling). */
export function athOf(h: ScopeHistory): { usd: number; ts: number } | null {
  let best: { usd: number; ts: number } | null = null;
  for (const p of h.points) if (best == null || p.total > best.usd) best = { usd: p.total, ts: p.t };
  return best;
}
