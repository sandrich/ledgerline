// Aave interest earned / paid, gas, and the rate history of the reserves a scope holds.
//
// Interest is measured per segment of the merged history (two consecutive events of one
// (address, chain) slice, the same segments the price PnL uses, lib/queries/pnl.ts) and per Aave
// position token (aToken = supply side, variable / stable debt token = borrow side), in units of the
// underlying, valued at the later event's price (the value change of a row is a0 x (p1 - p0) price
// PnL plus (a1 - a0) x p1, so interest valued at p1 never overlaps the price PnL):
//
//   ledger  interest = (a1 - a0) - principal moved in between. Principal comes from the transactions
//           ledger: per (tx, address, reserve) the net underlying sent to (supply / repay) or received
//           from (withdraw / borrow) the reserve's aToken contract, assigned to the side whose position
//           token was minted / burned in that tx (flash loans net out); aToken transfers between
//           addresses count with their exact amount. Mint / burn Transfer amounts are NOT principal:
//           Aave v3 emits them as amount +/- the interest accrued since the user's last action. They
//           are only used when no underlying leg exists (onBehalfOf supplies, liquidations, repay with
//           aTokens), where that small error is accepted.
//   index   interest = a0 x (I1 / I0 - 1) with the reserve's liquidity / variable borrow index at both
//           events (daily backfill, lib/history/aave-rates.ts; interpolated geometrically between
//           daily reads, extrapolated with the latest APY after the last one). Exact while the
//           position is unchanged; misses only the partial day of an action.
//   estimate a0 x ((1 + APY)^(dt / year) - 1) with the latest known APY (no index stored yet).
// A segment uses the ledger when the ledger of its (address, chain) was ingested after the segment
// ended. The ledger figure is cross-checked against the index figure: when they differ by more than
// a 50% APY equivalent on the position (a missed principal movement, not interest) the index wins.
//
// Gas: tx.fee_usd of transactions sent by an address of the scope (the ledger stores fees only for
// transactions sent by a tracked EOA). A Safe's transactions are paid by whoever executes them.
import type {
  Chain,
  HistoryRange,
  RatePoint,
  RatesResponse,
  ReserveRateSeries,
  Scope,
  YieldAsset,
  YieldBucket,
  YieldResponse,
} from './api-types';
import { all, get, jsonIds, nowSec, type QDb } from './db';
import { rangeBounds } from './history';
import { DAY, MAX_POINTS, assetSymbol, isChain } from './meta';
import { type ScopeHistory, type WindowYield, loadScopeHistory } from './pnl';
import { resolveScope, scopeToString } from './scope';
import { type TokenMap, loadTokens, tokenMeta } from './state';

const YEAR = 365 * DAY;
const ZERO = '0x0000000000000000000000000000000000000000';
/** ledger vs index tolerance, as an APY on the larger of the two balances */
const LEDGER_TOLERANCE_APY = 0.5;

type Side = 'supply' | 'borrow';
type Method = 'ledger' | 'index' | 'estimate';

function hasTable(db: QDb, name: string): boolean {
  return !!get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

// ---------- reserves ----------

interface PositionToken {
  chain: Chain;
  token: string;
  side: Side;
  market: string;
  /** underlying, lowercase */
  asset: string;
  /** borrow side: 'vdebt' | 'sdebt' */
  kind: string;
}

/** Aave position tokens by `${chain}:${token}` and the aToken contract of each reserve. */
function positionTokens(tokens: TokenMap): { byToken: Map<string, PositionToken>; aTokenOf: Map<string, string>; reserveOfAToken: Map<string, string> } {
  const byToken = new Map<string, PositionToken>();
  const aTokenOf = new Map<string, string>(); // `${chain}|${market}|${asset}` -> aToken
  const reserveOfAToken = new Map<string, string>(); // `${chain}:${aToken}` -> `${market}|${asset}`
  for (const t of tokens.values()) {
    if (!t.market || !t.underlying) continue;
    if (t.kind !== 'atoken' && t.kind !== 'vdebt' && t.kind !== 'sdebt') continue;
    const side: Side = t.kind === 'atoken' ? 'supply' : 'borrow';
    byToken.set(`${t.chain}:${t.address}`, { chain: t.chain, token: t.address, side, market: t.market, asset: t.underlying, kind: t.kind });
    if (side === 'supply') {
      aTokenOf.set(`${t.chain}|${t.market}|${t.underlying}`, t.address);
      reserveOfAToken.set(`${t.chain}:${t.address}`, `${t.market}|${t.underlying}`);
    }
  }
  return { byToken, aTokenOf, reserveOfAToken };
}

// ---------- rate book ----------

interface DailyRate {
  ts: number;
  supplyApy: number | null;
  borrowApy: number | null;
  li: number | null;
  bi: number | null;
}

export class RateBook {
  /** `${market}|${asset}` -> daily rows (aave_rates) sorted by ts */
  private daily = new Map<string, DailyRate[]>();
  /** `${market}|${asset}` -> live APY points (aave_reserve_state) sorted by ts */
  private live = new Map<string, RatePoint[]>();

  constructor(db: QDb, reserves: string[]) {
    const keys = [...new Set(reserves)];
    if (!keys.length) return;
    if (hasTable(db, 'aave_rates')) {
      const rows = all<{ market: string; asset: string; ts: number; s: number | null; b: number | null; li: number | null; bi: number | null }>(
        db,
        `SELECT market, lower(asset) AS asset, ts, supply_apy AS s, borrow_apy AS b, liquidity_index AS li, borrow_index AS bi
         FROM aave_rates WHERE (market || '|' || lower(asset)) IN (SELECT value FROM json_each(?)) ORDER BY ts`,
        JSON.stringify(keys),
      );
      for (const r of rows) {
        const k = `${r.market}|${r.asset}`;
        let a = this.daily.get(k);
        if (!a) this.daily.set(k, (a = []));
        a.push({ ts: r.ts, supplyApy: r.s, borrowApy: r.b, li: r.li, bi: r.bi });
      }
    }
    if (hasTable(db, 'aave_reserve_state')) {
      const rows = all<{ market: string; asset: string; ts: number; s: number | null; b: number | null }>(
        db,
        `SELECT r.market AS market, lower(r.asset) AS asset, s.ts AS ts, r.supply_apy AS s, r.borrow_apy AS b
         FROM aave_reserve_state r JOIN snapshots s ON s.id = r.snapshot_id
         WHERE (r.market || '|' || lower(r.asset)) IN (SELECT value FROM json_each(?)) ORDER BY s.ts`,
        JSON.stringify(keys),
      );
      for (const r of rows) {
        const k = `${r.market}|${r.asset}`;
        let a = this.live.get(k);
        if (!a) this.live.set(k, (a = []));
        a.push({ t: r.ts, supplyApy: r.s, borrowApy: r.b });
      }
    }
  }

  /** Daily rows and live points merged, sorted by time (for the rates API). */
  series(reserve: string): RatePoint[] {
    const out: RatePoint[] = (this.daily.get(reserve) ?? []).map((d) => ({ t: d.ts, supplyApy: d.supplyApy, borrowApy: d.borrowApy }));
    for (const p of this.live.get(reserve) ?? []) out.push(p);
    return out.sort((a, b) => a.t - b.t);
  }

  /** APY of a side at t: the last known value at or before t, else the first one after. */
  apyAt(reserve: string, side: Side, t: number): number | null {
    let best: { t: number; v: number } | null = null;
    let first: { t: number; v: number } | null = null;
    const consider = (pt: number, v: number | null) => {
      if (v == null) return;
      if (pt <= t && (!best || pt >= best.t)) best = { t: pt, v };
      if (!first || pt < first.t) first = { t: pt, v };
    };
    for (const d of this.daily.get(reserve) ?? []) consider(d.ts, side === 'supply' ? d.supplyApy : d.borrowApy);
    for (const p of this.live.get(reserve) ?? []) consider(p.t, side === 'supply' ? p.supplyApy : p.borrowApy);
    const b = best as { t: number; v: number } | null;
    const f = first as { t: number; v: number } | null;
    return b?.v ?? f?.v ?? null;
  }

  /** Reserve index of a side at t (see file comment), null without any daily read. */
  indexAt(reserve: string, side: Side, t: number): number | null {
    const rows = (this.daily.get(reserve) ?? []).filter((r) => (side === 'supply' ? r.li : r.bi) != null);
    if (!rows.length) return null;
    const idx = (r: DailyRate) => (side === 'supply' ? r.li : r.bi) as number;
    let lo = 0;
    let hi = rows.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts <= t) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const grow = (i: number, apy: number | null, dt: number) => i * Math.pow(1 + (apy ?? 0), dt / YEAR);
    if (k < 0) {
      const f = rows[0];
      return grow(idx(f), side === 'supply' ? f.supplyApy : f.borrowApy, t - f.ts);
    }
    const r0 = rows[k];
    if (r0.ts === t) return idx(r0);
    const r1 = rows[k + 1];
    // between two reads: geometric interpolation (the index grows smoothly; better than any APY)
    if (r1) return idx(r0) * Math.pow(idx(r1) / idx(r0), (t - r0.ts) / (r1.ts - r0.ts));
    return grow(idx(r0), this.apyAt(reserve, side, t), t - r0.ts);
  }
}

// ---------- ledger principal ----------

interface PrincipalMove {
  ts: number;
  /** change of the position in underlying units (supply: + supplied; borrow: + borrowed) */
  delta: number;
}

/** Ledger coverage per `${addressId}|${chain}`: unix time of the last ingestion (null = never). */
function ledgerCoverage(db: QDb, addressIds: number[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!hasTable(db, 'ledger_state')) return out;
  for (const r of all<{ a: number; c: string; u: number | null; b: number | null }>(
    db,
    'SELECT address_id AS a, chain AS c, updated_at AS u, last_block AS b FROM ledger_state WHERE address_id IN (SELECT value FROM json_each(?))',
    jsonIds(addressIds),
  )) {
    if (r.b != null && r.u != null) out.set(`${r.a}|${r.c}`, r.u);
  }
  return out;
}

/**
 * Principal movements per `${addressId}|${chain}|${positionToken}` (sorted by ts) from the ledger.
 * See the file comment for the rules.
 */
function ledgerPrincipal(db: QDb, addressIds: number[], tokens: TokenMap): Map<string, PrincipalMove[]> {
  const out = new Map<string, PrincipalMove[]>();
  if (!hasTable(db, 'tx_transfers') || !hasTable(db, 'tx_addresses')) return out;
  const addrRows = all<{ id: number; address: string }>(db, 'SELECT id, lower(address) AS address FROM addresses WHERE id IN (SELECT value FROM json_each(?))', jsonIds(addressIds));
  const idOf = new Map(addrRows.map((r) => [r.address, r.id]));
  const { byToken, aTokenOf, reserveOfAToken } = positionTokens(tokens);
  if (!byToken.size) return out;
  const legs = all<{ chain: string; hash: string; ts: number; token: string; f: string; t: string; amount: number | null }>(
    db,
    `SELECT tt.chain AS chain, tt.hash AS hash, x.ts AS ts, lower(tt.token) AS token, lower(tt.from_addr) AS f, lower(tt.to_addr) AS t, tt.amount AS amount
     FROM tx_transfers tt JOIN tx x ON x.chain = tt.chain AND x.hash = tt.hash
     WHERE tt.kind_hint = 'erc20' AND tt.amount IS NOT NULL
       AND EXISTS (SELECT 1 FROM tx_addresses ta WHERE ta.chain = tt.chain AND ta.hash = tt.hash AND ta.address_id IN (SELECT value FROM json_each(?)))
     ORDER BY x.ts, tt.hash`,
    jsonIds(addressIds),
  );
  // group per (chain, hash)
  const txs = new Map<string, typeof legs>();
  for (const l of legs) {
    const k = `${l.chain}|${l.hash}`;
    let a = txs.get(k);
    if (!a) txs.set(k, (a = []));
    a.push(l);
  }
  const push = (addressId: number, chain: string, token: string, ts: number, delta: number) => {
    if (!delta) return;
    const k = `${addressId}|${chain}|${token}`;
    let a = out.get(k);
    if (!a) out.set(k, (a = []));
    a.push({ ts, delta });
  };
  for (const tx of txs.values()) {
    const chain = tx[0].chain;
    const ts = tx[0].ts;
    // per (address, reserve) accumulators
    type Acc = { aMint: number; aBurn: number; aIn: number; aOut: number; dMint: number; dBurn: number; dToken: string | null; uToPool: number; uFromPool: number; uLegs: number };
    const acc = new Map<string, Acc>(); // `${addressId}|${market}|${asset}`
    const getAcc = (id: number, reserve: string): Acc => {
      const k = `${id}|${reserve}`;
      let a = acc.get(k);
      if (!a) acc.set(k, (a = { aMint: 0, aBurn: 0, aIn: 0, aOut: 0, dMint: 0, dBurn: 0, dToken: null, uToPool: 0, uFromPool: 0, uLegs: 0 }));
      return a;
    };
    for (const l of tx) {
      const amt = Math.abs(l.amount ?? 0);
      const pos = byToken.get(`${chain}:${l.token}`);
      if (pos) {
        const reserve = `${pos.market}|${pos.asset}`;
        const fromId = idOf.get(l.f);
        const toId = idOf.get(l.t);
        if (pos.side === 'supply') {
          if (toId != null) {
            const a = getAcc(toId, reserve);
            if (l.f === ZERO) a.aMint += amt;
            else a.aIn += amt;
          }
          if (fromId != null) {
            const a = getAcc(fromId, reserve);
            if (l.t === ZERO) a.aBurn += amt;
            else a.aOut += amt;
          }
        } else {
          if (toId != null && l.f === ZERO) {
            const a = getAcc(toId, reserve);
            a.dMint += amt;
            a.dToken = pos.token;
          }
          if (fromId != null && l.t === ZERO) {
            const a = getAcc(fromId, reserve);
            a.dBurn += amt;
            a.dToken = pos.token;
          }
        }
        continue;
      }
      // underlying between a scope address and a reserve's aToken contract
      const toPool = reserveOfAToken.get(`${chain}:${l.t}`);
      const fromPool = reserveOfAToken.get(`${chain}:${l.f}`);
      if (toPool && toPool.endsWith(`|${l.token}`) && idOf.has(l.f)) {
        const a = getAcc(idOf.get(l.f)!, toPool);
        a.uToPool += amt;
        a.uLegs++;
      }
      if (fromPool && fromPool.endsWith(`|${l.token}`) && idOf.has(l.t)) {
        const a = getAcc(idOf.get(l.t)!, fromPool);
        a.uFromPool += amt;
        a.uLegs++;
      }
    }
    for (const [k, a] of acc) {
      const [idStr, market, asset] = k.split('|');
      const id = Number(idStr);
      const aToken = aTokenOf.get(`${chain}|${market}|${asset}`);
      const aMoved = a.aMint > 0 || a.aBurn > 0;
      const dMoved = a.dMint > 0 || a.dBurn > 0;
      const n = a.uToPool - a.uFromPool; // > 0: into the reserve
      let ps = a.aIn - a.aOut; // aToken transfers: exact amounts
      let pd = 0;
      const transferAccrual = a.aIn > 0 || a.aOut > 0; // mints next to a transfer are accrued interest
      if (a.uLegs > 0 && aMoved && !dMoved) ps += n;
      else if (a.uLegs > 0 && dMoved && !aMoved) pd += -n;
      else if (aMoved || dMoved) {
        // no underlying leg (or both sides moved): fall back to the mint / burn amounts
        if (aMoved && !transferAccrual) ps += a.aMint - a.aBurn;
        if (dMoved) pd += a.dMint - a.dBurn;
      }
      if (aToken) push(id, chain, aToken, ts, ps);
      if (a.dToken) push(id, chain, a.dToken, ts, pd);
    }
  }
  return out;
}

function principalBetween(moves: PrincipalMove[] | undefined, t0: number, t1: number): number {
  if (!moves) return 0;
  let s = 0;
  for (const m of moves) if (m.ts > t0 && m.ts <= t1) s += m.delta;
  return s;
}

// ---------- interest per segment ----------

export interface InterestPiece {
  /** plotted time of the segment's end event */
  t: number;
  /** UTC day the interest accrued in (the day before the end event's effective time) */
  day: number;
  asset: string;
  symbol: string;
  side: Side;
  /** USD at the end event's price; positive = earned (supply) / paid (borrow) */
  usd: number;
  method: Method;
}

export interface ScopeYield {
  pieces: InterestPiece[];
  /** gas of each transaction sent by the scope (unix time, positive USD), sorted by time */
  gas: { ts: number; usd: number }[];
  gasKnown: boolean;
  /** segments where the ledger figure was replaced by the index figure */
  ledgerRejected: number;
}

export function loadScopeYield(db: QDb, addressIds: number[], h: ScopeHistory, tokens: TokenMap): ScopeYield {
  const res: ScopeYield = { pieces: [], gas: [], gasKnown: false, ledgerRejected: 0 };
  if (!addressIds.length) return res;
  const { byToken } = positionTokens(tokens);
  const reserves = [...byToken.values()].map((p) => `${p.market}|${p.asset}`);
  const book = new RateBook(db, reserves);
  const coverage = ledgerCoverage(db, addressIds);
  const principal = coverage.size ? ledgerPrincipal(db, addressIds, tokens) : new Map<string, PrincipalMove[]>();

  for (const [slice, sh] of h.slices) {
    const [aStr, chain] = slice.split('|');
    if (!isChain(chain)) continue;
    const covered = coverage.get(slice);
    for (let i = 0; i + 1 < sh.events.length; i++) {
      const e0 = sh.events[i];
      const e1 = sh.events[i + 1];
      const dt = e1.eff - e0.eff;
      if (dt <= 0) continue;
      const amounts = new Map<string, { a0: number; a1: number; key: string; asset: string; symbol: string; p0: number }>();
      for (const r of e0.rows) {
        if (!byToken.has(`${chain}:${r.token}`)) continue;
        amounts.set(r.token, { a0: r.amount, a1: 0, key: r.key, asset: r.asset, symbol: r.symbol, p0: r.price });
      }
      for (const r of e1.rows) {
        if (!byToken.has(`${chain}:${r.token}`)) continue;
        const x = amounts.get(r.token);
        if (x) x.a1 = r.amount;
        else amounts.set(r.token, { a0: 0, a1: r.amount, key: r.key, asset: r.asset, symbol: r.symbol, p0: r.price });
      }
      for (const [token, x] of amounts) {
        const pos = byToken.get(`${chain}:${token}`)!;
        const reserve = `${pos.market}|${pos.asset}`;
        // index (or APY) figure
        let units = 0;
        let method: Method = 'estimate';
        if (x.a0 > 0) {
          const i0 = book.indexAt(reserve, pos.side, e0.eff);
          const i1 = book.indexAt(reserve, pos.side, e1.eff);
          if (i0 != null && i1 != null && i0 > 0) {
            units = x.a0 * (i1 / i0 - 1);
            method = 'index';
          } else {
            const apy = book.apyAt(reserve, pos.side, e0.eff);
            units = apy != null ? x.a0 * (Math.pow(1 + apy, dt / YEAR) - 1) : 0;
          }
        } else method = 'index';
        // ledger figure when the ledger covers the segment
        if (covered != null && covered >= e1.eff) {
          const p = principalBetween(principal.get(`${aStr}|${chain}|${token}`), e0.eff, e1.eff);
          const ledgerUnits = x.a1 - x.a0 - p;
          const tol = Math.max(x.a0, x.a1) * LEDGER_TOLERANCE_APY * (dt / YEAR) + 1e-12 * Math.max(x.a0, x.a1, 1);
          if (Math.abs(ledgerUnits - units) <= tol) {
            units = ledgerUnits;
            method = 'ledger';
          } else res.ledgerRejected++;
        }
        if (!units) continue;
        const price = e1.prices.get(x.key) || x.p0;
        if (!(price > 0)) continue;
        res.pieces.push({
          t: e1.t,
          day: Math.floor((e1.eff - 1) / DAY) * DAY,
          asset: x.asset,
          symbol: x.symbol,
          side: pos.side,
          usd: units * price,
          method,
        });
      }
    }
  }

  // gas
  if (hasTable(db, 'tx') && coverage.size) {
    res.gasKnown = true;
    const rows = all<{ ts: number; fee: number }>(
      db,
      `SELECT x.ts AS ts, x.fee_usd AS fee FROM tx x
       WHERE x.fee_usd IS NOT NULL AND lower(x.from_addr) IN (SELECT lower(address) FROM addresses WHERE id IN (SELECT value FROM json_each(?)))
       ORDER BY x.ts`,
      jsonIds(addressIds),
    );
    res.gas = rows.map((r) => ({ ts: r.ts, usd: r.fee }));
  }
  return res;
}

/** Interest and gas of the window (from, to] (same bounds as the PnL window). */
export function windowYield(y: ScopeYield, from: number, to: number): WindowYield & { earnedUsd: number; paidUsd: number; methods: Set<Method> } {
  const daily = new Map<number, { interestUsd: number; gasUsd: number }>();
  let earned = 0;
  let paid = 0;
  const methods = new Set<Method>();
  for (const p of y.pieces) {
    if (p.t <= from || p.t > to) continue;
    methods.add(p.method);
    if (p.side === 'supply') earned += p.usd;
    else paid += p.usd;
    const d = daily.get(p.day) ?? { interestUsd: 0, gasUsd: 0 };
    d.interestUsd += p.side === 'supply' ? p.usd : -p.usd;
    daily.set(p.day, d);
  }
  let gas = 0;
  for (const g of y.gas) {
    // a transaction inside (from, to] belongs to the window (same bounds as the value change)
    if (g.ts <= from || g.ts > to) continue;
    gas += g.usd;
    const day = Math.floor(g.ts / DAY) * DAY;
    const d = daily.get(day) ?? { interestUsd: 0, gasUsd: 0 };
    d.gasUsd += g.usd;
    daily.set(day, d);
  }
  return {
    interestUsd: earned - paid,
    gasUsd: gas,
    earnedUsd: earned,
    paidUsd: paid,
    estimated: methods.has('estimate'),
    methods,
    daily: [...daily].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, ...v })),
  };
}

/** Week start (Monday 00:00 UTC) of a unix time. */
function weekStart(t: number): number {
  const d = Math.floor(t / DAY);
  // 1970-01-01 was a Thursday: (d + 3) % 7 = days since Monday
  return (d - ((d + 3) % 7)) * DAY;
}

export function getYield(db: QDb, scope: Scope, range: HistoryRange, now = nowSec()): YieldResponse | null {
  const ids = resolveScope(db, scope);
  if (!ids) return null;
  const { from, to } = rangeBounds(db, range, ids, now);
  const tokens = loadTokens(db);
  const h = loadScopeHistory(db, ids, tokens);
  const y = loadScopeYield(db, ids, h, tokens);
  const w = windowYield(y, from, to);
  const bucket: YieldResponse['bucket'] = range === '1y' || range === 'all' ? 'week' : 'day';
  const key = (t: number) => (bucket === 'week' ? weekStart(t) : Math.floor(t / DAY) * DAY);
  const buckets = new Map<number, YieldBucket>();
  const at = (t: number) => {
    const k = key(t);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { t: k, earnedUsd: 0, paidUsd: 0, gasUsd: 0, netUsd: 0, cumulativeUsd: 0 }));
    return b;
  };
  const byAsset = new Map<string, YieldAsset>();
  for (const p of y.pieces) {
    if (p.t <= from || p.t > to) continue;
    const b = at(p.day);
    if (p.side === 'supply') b.earnedUsd += p.usd;
    else b.paidUsd += p.usd;
    let a = byAsset.get(p.asset);
    if (!a) byAsset.set(p.asset, (a = { asset: p.asset, symbol: assetSymbol(p.asset, p.symbol), earnedUsd: 0, paidUsd: 0 }));
    if (p.side === 'supply') a.earnedUsd += p.usd;
    else a.paidUsd += p.usd;
  }
  for (const d of w.daily) if (d.gasUsd) at(d.t).gasUsd += d.gasUsd;
  let cum = 0;
  const list = [...buckets.values()].sort((a, b) => a.t - b.t);
  for (const b of list) {
    b.netUsd = b.earnedUsd - b.paidUsd - b.gasUsd;
    cum += b.netUsd;
    b.cumulativeUsd = cum;
  }
  const methods = [...w.methods];
  return {
    scope: scopeToString(scope),
    range,
    from,
    to,
    earnedUsd: w.earnedUsd,
    paidUsd: w.paidUsd,
    gasUsd: w.gasUsd,
    netUsd: w.earnedUsd - w.paidUsd - w.gasUsd,
    method: methods.length === 0 ? 'none' : methods.length === 1 ? methods[0] : 'mixed',
    estimated: w.estimated,
    gasKnown: y.gasKnown,
    byAsset: [...byAsset.values()].sort((a, b) => Math.abs(b.earnedUsd) + Math.abs(b.paidUsd) - (Math.abs(a.earnedUsd) + Math.abs(a.paidUsd))),
    bucket,
    buckets: list,
  };
}

// ---------- rates API ----------

export function getRates(db: QDb, scope: Scope, range: HistoryRange, now = nowSec()): RatesResponse | null {
  const ids = resolveScope(db, scope);
  if (!ids) return null;
  const { from, to } = rangeBounds(db, range, ids, now);
  const tokens = loadTokens(db);
  const { byToken } = positionTokens(tokens);
  const h = loadScopeHistory(db, ids, tokens);

  // reserves held in the range (any event whose state overlaps it) and the Aave rows per event
  type Held = { chain: Chain; market: string; asset: string; supplied: boolean; borrowed: boolean };
  const held = new Map<string, Held>();
  for (const [slice, sh] of h.slices) {
    const chain = slice.split('|')[1];
    if (!isChain(chain)) continue;
    sh.events.forEach((e, i) => {
      const next = sh.events[i + 1];
      if (e.t > to || (next && next.t <= from)) return;
      for (const r of e.rows) {
        const pos = byToken.get(`${chain}:${r.token}`);
        if (!pos) continue;
        const k = `${pos.market}|${pos.asset}`;
        const x = held.get(k) ?? { chain, market: pos.market, asset: pos.asset, supplied: false, borrowed: false };
        if (pos.side === 'supply') x.supplied = true;
        else x.borrowed = true;
        held.set(k, x);
      }
    });
  }
  const book = new RateBook(db, [...held.keys()]);
  const reserves: ReserveRateSeries[] = [];
  const times = new Set<number>();
  for (const [k, x] of held) {
    const pts = book.series(k).filter((p) => p.t >= from - DAY && p.t <= to);
    for (const p of pts) times.add(p.t);
    const u = tokenMeta(tokens, x.chain, x.asset);
    reserves.push({ ...x, symbol: u?.symbol ?? x.asset, points: downsamplePoints(pts) });
  }
  reserves.sort((a, b) => a.chain.localeCompare(b.chain) || a.market.localeCompare(b.market) || a.symbol.localeCompare(b.symbol));

  // net APY at every rate time: positions of the last event at or before t per slice
  const netApy: RatesResponse['netApy'] = [];
  const sorted = [...times].sort((a, b) => a - b);
  for (const t of sorted) {
    let sup = 0;
    let bor = 0;
    let supInt = 0;
    let borInt = 0;
    for (const [slice, sh] of h.slices) {
      const chain = slice.split('|')[1];
      let e = null as (typeof sh.events)[number] | null;
      for (const ev of sh.events) {
        if (ev.eff <= t) e = ev;
        else break;
      }
      if (!e) continue;
      for (const r of e.rows) {
        const pos = byToken.get(`${chain}:${r.token}`);
        if (!pos) continue;
        const usd = r.amount * r.price;
        const apy = book.apyAt(`${pos.market}|${pos.asset}`, pos.side, t);
        if (pos.side === 'supply') {
          sup += usd;
          supInt += usd * (apy ?? 0);
        } else {
          bor += usd;
          borInt += usd * (apy ?? 0);
        }
      }
    }
    const equity = sup - bor;
    netApy.push({ t, netApy: sup > 0 && equity > 1 ? (supInt - borInt) / equity : null });
  }
  return { scope: scopeToString(scope), range, from, to, reserves, netApy: downsampleNet(netApy) };
}

function pick<T extends { t: number }>(pts: T[]): T[] {
  if (pts.length <= MAX_POINTS) return pts;
  const step = pts.length / MAX_POINTS;
  const out: T[] = [];
  for (let i = 0; i < MAX_POINTS; i++) out.push(pts[Math.min(pts.length - 1, Math.floor(i * step))]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out[out.length - 1] = pts[pts.length - 1];
  return out;
}
const downsamplePoints = (p: RatePoint[]) => pick(p);
const downsampleNet = (p: RatesResponse['netApy']) => pick(p);
