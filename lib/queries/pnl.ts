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
// withdrawals, transfers between tracked addresses, Aave interest, fees) is otherUsd; when yield data
// is passed in (PnlExtras, lib/queries/yield.ts) Aave interest and gas are reported separately as
// interestUsd / gasUsd and taken out of otherUsd. PnlExtras.fx adds the window in EUR / CHF with the
// currency effect split out (currencyPnl). unleveredSampler builds the unleveraged comparison line.
//
// returnPct is the return on invested capital: pnlUsd / (startUsd + peak cumulative net deposits in
// the window), where the net deposit at a chart point is its value change minus its PnL (internal
// transfers net out because both slices change at the same point). Without deposits it equals
// pnlUsd / startUsd; with them a $376 start followed by a $19k deposit reads as ~+93%, not +4'800%.
// Re-depositing what was withdrawn earlier in the window does not count as new capital. A time
// weighted return was rejected: periods holding only dust dominate it (1y read -4% on +$18k PnL).
import type { Chain, CurrencyPnl, FxCurrency, PnlPeriod, PnlSummary, PnlWindow } from './api-types';
import { all, jsonIds, type QDb } from './db';
import { DAY, RANGE_SECONDS, assetOf, assetSymbol, isChain } from './meta';
import { CHAIN_ENABLED_SQL, KIND_RANK, type SnapshotKind, type TokenMap, canonicalKey, sliceKey, tokenMeta } from './state';

export const PNL_WINDOWS: PnlWindow[] = ['24h', '7d', '30d', '90d', '1y', 'all'];

export interface Row {
  /** token contract (lowercase) of the balance row */
  token: string;
  key: string;
  asset: string;
  symbol: string;
  sign: 1 | -1;
  amount: number;
  /** implied price |usd| / amount; 0 when the row was valued without a price */
  price: number;
}

export interface SliceEvent {
  snapshotId: number;
  /** plotted time (daily at its day start) */
  t: number;
  /** time the state was valued at (daily: ts + 1 day) */
  eff: number;
  kind: SnapshotKind;
  /** net usd of the slice (position_values) */
  usd: number;
  /** borrowed usd of the slice, positive (every borrow row, priced or not); usd + debt = gross assets */
  debt: number;
  rows: Row[];
  /** implied price per key among rows that had one; keys present with usd = 0 map to 0 */
  prices: Map<string, number>;
}

interface Segment {
  pnl: number;
  /** price PnL of the asset rows only (wallet + supplied, debt excluded) */
  assetPnl: number;
  byAsset: Map<string, number>;
}

export interface SliceHistory {
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
  /**
   * merged net worth series (one entry per distinct event time) with the PnL realised at each point.
   * assets: gross assets (wallet + supplied) at the point; assetPnl: the asset rows' share of pnl.
   */
  points: { t: number; total: number; pnl: number; before: number; assets: number; assetPnl: number }[];
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
      debt: 0,
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
    if (b.side === 'borrow') e.debt += usd;
    if (price > 0) e.prices.set(key, price);
    else if (!e.prices.has(key)) e.prices.set(key, 0);
    if (price <= 0) continue;
    const symbol = symbolFor(tokens, b.c, token) ?? key;
    const asset = assetOf(key, symbol);
    if (!out.symbols.has(asset)) out.symbols.set(asset, assetSymbol(asset, symbol));
    e.rows.push({ token, key, asset, symbol, sign: b.side === 'borrow' ? -1 : 1, amount, price });
  }

  const book = new PriceBook(db);
  for (const sh of out.slices.values()) {
    sh.events.sort((x, y) => x.t - y.t || KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.snapshotId - y.snapshotId);
    sh.prefix.push(0);
    for (let i = 0; i + 1 < sh.events.length; i++) {
      const e0 = sh.events[i];
      const e1 = sh.events[i + 1];
      const seg: Segment = { pnl: 0, assetPnl: 0, byAsset: new Map() };
      for (const r of e0.rows) {
        let p1 = e1.prices.get(r.key);
        if (p1 === undefined) p1 = book.at(r.key, e1.eff) ?? 0;
        if (!(p1 > 0)) continue;
        const v = r.sign * r.amount * (p1 - r.price);
        if (v === 0) continue;
        seg.pnl += v;
        if (r.sign > 0) seg.assetPnl += v;
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
  const evs: { t: number; rank: number; slice: string; usd: number; debt: number; pnl: number; assetPnl: number }[] = [];
  for (const [slice, sh] of h.slices) {
    sh.events.forEach((e, i) =>
      evs.push({
        t: e.t,
        rank: KIND_RANK[e.kind],
        slice,
        usd: e.usd,
        debt: e.debt,
        pnl: i > 0 ? sh.segments[i - 1].pnl : 0,
        assetPnl: i > 0 ? sh.segments[i - 1].assetPnl : 0,
      }),
    );
  }
  evs.sort((x, y) => x.t - y.t || x.rank - y.rank);
  const cur = new Map<string, { usd: number; debt: number }>();
  const points: ScopeHistory['points'] = [];
  let total = 0;
  let debt = 0;
  let before = 0;
  let pnl = 0;
  let assetPnl = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const prev = cur.get(e.slice);
    total += e.usd - (prev?.usd ?? 0);
    debt += e.debt - (prev?.debt ?? 0);
    cur.set(e.slice, { usd: e.usd, debt: e.debt });
    pnl += e.pnl;
    assetPnl += e.assetPnl;
    if (i + 1 < evs.length && evs[i + 1].t === e.t) continue;
    points.push({ t: e.t, total, pnl, before, assets: total + debt, assetPnl });
    before = total;
    pnl = 0;
    assetPnl = 0;
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

/** Optional inputs of a PnL window beyond the price history (lib/queries/yield.ts, lib/queries/fx.ts). */
export interface PnlExtras {
  /** Aave interest and gas of the scope in (from, to]; null when nothing is known */
  yieldIn?: (from: number, to: number) => WindowYield | null;
  /** display currency rates (units of the currency per USD) at a unix time */
  fx?: { currencies: FxCurrency[]; rateAt: (currency: FxCurrency, t: number) => number | null };
}

export interface WindowYield {
  /** earned - paid, USD at the time */
  interestUsd: number;
  /** positive cost */
  gasUsd: number;
  estimated: boolean;
  /** per UTC day (day start): net interest and gas, for currency conversion */
  daily: { t: number; interestUsd: number; gasUsd: number }[];
}

/** Below this gross asset value a step's asset return is undefined: U is carried forward (plus flows). */
const UNLEVERED_MIN_ASSETS = 1;

/**
 * Unleveraged comparison line, sampled at any time t >= t0 (null before t0). It starts at the net
 * worth of the last merged point at or before t0 and moves, per merged point, by the asset rows'
 * price return only (as if the gross assets had been held without debt) plus the same non price
 * change (deposits, withdrawals, interest, fees) the net worth line gets:
 *   U_t = U_{t-1} x (1 + assetPnl_t / assets_{t-1}) + (total_t - total_{t-1} - pnl_t)
 * Without debt assetPnl = pnl and assets = total, so U equals the net worth on every point.
 */
export function unleveredSampler(h: ScopeHistory, t0: number): (t: number) => number | null {
  const pts = h.points;
  let k0 = -1;
  for (let k = 0; k < pts.length && pts[k].t <= t0; k++) k0 = k;
  if (k0 < 0) {
    // the scope has no point at or before t0: start at its first point
    if (!pts.length) return () => null;
    k0 = 0;
  }
  const ts: number[] = [pts[k0].t];
  const us: number[] = [pts[k0].total];
  let u = pts[k0].total;
  for (let k = k0 + 1; k < pts.length; k++) {
    const p = pts[k];
    const prevAssets = pts[k - 1].assets;
    const flow = p.total - p.before - p.pnl;
    u = prevAssets >= UNLEVERED_MIN_ASSETS ? u * (1 + p.assetPnl / prevAssets) + flow : u + flow;
    ts.push(p.t);
    us.push(u);
  }
  return (t: number) => {
    if (t < t0) return null;
    let lo = 0;
    let hi = ts.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] <= t) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return us[best];
  };
}

/**
 * Value change of a window in a display currency C, split exactly into
 *   market   = sum over merged points of pnl_t x r_t                 (price PnL converted at the day)
 *   fxEffect = sum over merged points of total_{t-1} x (r_t - r_{t-1}) (USD moving against C)
 *   interest / gas = daily interest and gas converted at the day
 *   other    = change - market - fxEffect - interest + gas           (deposits, withdrawals)
 * with change = end x r_end - start x r_start. r = units of C per USD (last published day).
 */
export function currencyPnl(
  h: ScopeHistory,
  currency: FxCurrency,
  rateAt: (t: number) => number | null,
  from: number,
  to: number,
  startUsd: number,
  endUsd: number,
  y: WindowYield | null,
): CurrencyPnl | null {
  const r0 = rateAt(from);
  if (r0 == null) return null;
  let prevRate = r0;
  let prevTotal = startUsd;
  let market = 0;
  let fxEffect = 0;
  for (const p of h.points) {
    if (p.t <= from) continue;
    if (p.t > to) break;
    const r = rateAt(p.t) ?? prevRate;
    market += p.pnl * r;
    fxEffect += prevTotal * (r - prevRate);
    prevTotal = p.total;
    prevRate = r;
  }
  // endUsd is the window's last state: the last merged point in it (or the start when none)
  const start = startUsd * r0;
  const end = endUsd * prevRate;
  let interest = 0;
  let gas = 0;
  for (const d of y?.daily ?? []) {
    const r = rateAt(d.t) ?? prevRate;
    interest += d.interestUsd * r;
    gas += d.gasUsd * r;
  }
  const change = end - start;
  return {
    currency,
    rateStart: r0,
    rateEnd: prevRate,
    start,
    end,
    change,
    market,
    fxEffect,
    interest: y ? interest : null,
    gas: y ? gas : null,
    other: change - market - fxEffect - interest + gas,
  };
}

/** PnL for one window [from, to] (to defaults to the latest event). */
export function pnlPeriod(h: ScopeHistory, window: PnlWindow, from: number, to = Infinity, extras?: PnlExtras): PnlPeriod {
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
  const y = extras?.yieldIn?.(from, to) ?? null;
  let currencies: PnlPeriod['currencies'];
  if (extras?.fx) {
    currencies = {};
    for (const c of extras.fx.currencies) {
      const cp = currencyPnl(h, c, (t) => extras.fx!.rateAt(c, t), from, to, startUsd, endUsd, y);
      if (cp) currencies[c] = cp;
    }
  }
  return {
    window,
    fromTs,
    startUsd,
    endUsd,
    changeUsd,
    pnlUsd: pnl,
    // dust capital (e.g. $0.0008 before the first deposit) gives a meaningless percentage
    returnPct: capital >= 1 ? pnl / capital : null,
    otherUsd: y ? changeUsd - pnl - y.interestUsd + y.gasUsd : changeUsd - pnl,
    ...(y ? { interestUsd: y.interestUsd, gasUsd: y.gasUsd, interestEstimated: y.estimated } : {}),
    ...(currencies ? { currencies } : {}),
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
export function pnlSummary(h: ScopeHistory, now: number, extras?: PnlExtras): PnlSummary {
  const out = {} as PnlSummary;
  for (const w of PNL_WINDOWS) {
    const from = w === 'all' ? (h.earliest ?? now) : Math.max(now - RANGE_SECONDS[w], h.earliest ?? -Infinity);
    out[w] = pnlPeriod(h, w, from, Infinity, extras);
  }
  return out;
}

/** All-time high of the merged net worth series (every event, no downsampling). */
export function athOf(h: ScopeHistory): { usd: number; ts: number } | null {
  let best: { usd: number; ts: number } | null = null;
  for (const p of h.points) if (best == null || p.total > best.usd) best = { usd: p.total, ts: p.t };
  return best;
}
