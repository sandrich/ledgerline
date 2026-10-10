// Aave rates / liquidation estimates per position and the scope-wide RiskSummary.
//
// Rates and risk parameters come from aave_reserve_state (written by the live snapshot): for every
// market the latest snapshot that has them. Per user the eMode category and the user configuration
// bitmap come from the account row of the current slice. All APY / LTV / liquidation fields stay null
// until the first live snapshot with rates exists.
//
// Effective parameters of a supplied reserve: not enabled as collateral (user configuration bit
// 2*id+1 unset) => LT = LTV = 0; in the user's eMode category (v3.2+: bit `id` of the category's
// collateral bitmap; v3.0 / v3.1: the reserve's configured category) => the category's LT / LTV;
// else the reserve's own LT / LTV.
//
// Liquidation price of collateral asset X (other assets' prices held constant, debt in X moves with
// X): HF = 1 when p x (sum amount_X x LT_X - debtAmount_X) + sum(other collateral usd x LT) - other
// debt usd = 0, so p_liq = (otherDebtUsd - otherCollateralUsd x LT) / (amount_X x LT_X - debtAmount_X).
import type { AavePositionSummary, Chain, LiquidationPoint, NetExposure, RiskSummary, Totals } from './api-types';
import { all, get, type QDb } from './db';
import { assetOf, assetSymbol } from './meta';
import type { ScopeHistory } from './pnl';
import { athOf } from './pnl';
import { type AaveAccountRow, type BalanceRow, type TokenMap, canonicalKey, tokenMeta } from './state';

export interface ReserveState {
  reserveId: number | null;
  supplyApy: number | null;
  borrowApy: number | null;
  ltvBps: number | null;
  ltBps: number | null;
  emodeCategory: number | null;
}

/**
 * market -> asset (lowercase underlying) -> latest stored reserve state. Only live snapshots write
 * these rows and they are written in time order, so the highest snapshot id is the latest (index
 * aave_reserve_state_market makes this a lookup, not a scan).
 */
export type ReserveStates = Map<string, Map<string, ReserveState>>;

export function loadReserveStates(db: QDb, markets: string[]): ReserveStates {
  const out: ReserveStates = new Map();
  if (!markets.length || !get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'aave_reserve_state'")) return out;
  for (const market of new Set(markets)) {
    const rows = all<{
      asset: string;
      reserve_id: number | null;
      supply_apy: number | null;
      borrow_apy: number | null;
      ltv_bps: number | null;
      lt_bps: number | null;
      emode_category: number | null;
    }>(
      db,
      `SELECT asset, reserve_id, supply_apy, borrow_apy, ltv_bps, lt_bps, emode_category FROM aave_reserve_state
       WHERE market = ? AND snapshot_id = (SELECT MAX(snapshot_id) FROM aave_reserve_state WHERE market = ?)`,
      market,
      market,
    );
    if (!rows.length) continue;
    out.set(
      market,
      new Map(
        rows.map((r) => [
          r.asset.toLowerCase(),
          {
            reserveId: r.reserve_id,
            supplyApy: r.supply_apy,
            borrowApy: r.borrow_apy,
            ltvBps: r.ltv_bps,
            ltBps: r.lt_bps,
            emodeCategory: r.emode_category,
          },
        ]),
      ),
    );
  }
  return out;
}

function bit(decimal: string | null, i: number | null): boolean | null {
  if (decimal == null || i == null) return null;
  try {
    return ((BigInt(decimal) >> BigInt(i)) & 1n) === 1n;
  } catch {
    return null;
  }
}

interface PosRow {
  asset: string;
  symbol: string;
  key: string;
  underlying: string;
  amount: number;
  /** positive usd */
  usd: number;
  side: 'supply' | 'borrow';
}

export interface PositionRisk {
  supplyApy: number | null;
  borrowApy: number | null;
  netApy: number | null;
  ltvUsed: number | null;
  liquidations: LiquidationPoint[];
  /** usd-weighted interest per year (supply - borrow), null without rates */
  annualYieldUsd: number | null;
  /** sum(collateral usd x LTV) */
  borrowPowerUsd: number | null;
  /** health factor recomputed from the stored LTs and current prices (cross-check) */
  computedHf: number | null;
}

function underlyingSymbol(tokens: TokenMap, chain: Chain, token: string): string | null {
  const t = tokenMeta(tokens, chain, token);
  if (t?.underlying) {
    const u = tokenMeta(tokens, chain, t.underlying);
    if (u?.symbol) return u.symbol;
  }
  return t?.symbol ?? null;
}

/**
 * Rates and liquidation points for each Aave position (keyed `${addressId}|${market}`) of the current
 * balances. Positions whose market has no stored rates get null fields and no liquidation points.
 */
export function positionRisks(
  db: QDb,
  balances: BalanceRow[],
  accounts: AaveAccountRow[],
  tokens: TokenMap,
): Map<string, PositionRisk> {
  const byPos = new Map<string, { addressId: number; market: string; chain: Chain; rows: PosRow[] }>();
  for (const b of balances) {
    if (b.side === 'wallet') continue;
    const t = tokenMeta(tokens, b.chain, b.token);
    const market = t?.market ?? `${b.chain}-unknown`;
    const k = `${b.addressId}|${market}`;
    let p = byPos.get(k);
    if (!p) {
      p = { addressId: b.addressId, market, chain: b.chain, rows: [] };
      byPos.set(k, p);
    }
    const key = canonicalKey(tokens, b.chain, b.token);
    const symbol = underlyingSymbol(tokens, b.chain, b.token) ?? key;
    p.rows.push({
      asset: assetOf(key, symbol),
      symbol,
      key,
      underlying: (t?.underlying ?? b.token).toLowerCase(),
      amount: b.amount,
      usd: Math.abs(b.usd),
      side: b.side,
    });
  }
  const reserves = loadReserveStates(
    db,
    [...byPos.values()].map((p) => p.market),
  );
  const accts = new Map(accounts.map((a) => [`${a.addressId}|${a.market}`, a]));
  const out = new Map<string, PositionRisk>();
  for (const [k, p] of byPos) {
    const rs = reserves.get(p.market);
    if (!rs) {
      out.set(k, { supplyApy: null, borrowApy: null, netApy: null, ltvUsed: null, liquidations: [], annualYieldUsd: null, borrowPowerUsd: null, computedHf: null });
      continue;
    }
    const acct = accts.get(k);
    let suppliedUsd = 0;
    let borrowedUsd = 0;
    let supplyInterest = 0;
    let borrowInterest = 0;
    let ratesKnown = true;
    let borrowPower = 0;
    let weightedLt = 0;
    // per asset: collateral amount x LT (units), collateral usd x LT, debt amount, debt usd, price
    const perAsset = new Map<string, { symbol: string; collLtUnits: number; collLtUsd: number; collUsd: number; collAmount: number; debtAmount: number; debtUsd: number }>();
    const pa = (r: PosRow) => {
      let e = perAsset.get(r.asset);
      if (!e) {
        e = { symbol: assetSymbol(r.asset, r.symbol), collLtUnits: 0, collLtUsd: 0, collUsd: 0, collAmount: 0, debtAmount: 0, debtUsd: 0 };
        perAsset.set(r.asset, e);
      }
      return e;
    };
    for (const r of p.rows) {
      const s = rs.get(r.underlying);
      if (r.side === 'borrow') {
        borrowedUsd += r.usd;
        if (s?.borrowApy == null) ratesKnown = false;
        else borrowInterest += r.usd * s.borrowApy;
        const e = pa(r);
        e.debtAmount += r.amount;
        e.debtUsd += r.usd;
        continue;
      }
      suppliedUsd += r.usd;
      if (s?.supplyApy == null) ratesKnown = false;
      else supplyInterest += r.usd * s.supplyApy;
      let lt = (s?.ltBps ?? 0) / 10_000;
      let ltv = (s?.ltvBps ?? 0) / 10_000;
      const enabled = bit(acct?.userConfig ?? null, s?.reserveId != null ? 2 * s.reserveId + 1 : null);
      if (enabled === false) {
        lt = 0;
        ltv = 0;
      } else if (acct?.emode && acct.emodeLtBps != null) {
        const inCategory = acct.emodeBitmap != null ? bit(acct.emodeBitmap, s?.reserveId ?? null) : s?.emodeCategory === acct.emode;
        if (inCategory) {
          lt = acct.emodeLtBps / 10_000;
          ltv = ltv > 0 ? (acct.emodeLtvBps ?? 0) / 10_000 : 0;
        }
      }
      borrowPower += r.usd * ltv;
      weightedLt += r.usd * lt;
      if (lt > 0) {
        const e = pa(r);
        e.collLtUnits += r.amount * lt;
        e.collLtUsd += r.usd * lt;
        e.collUsd += r.usd;
        e.collAmount += r.amount;
      }
    }
    const liquidations: LiquidationPoint[] = [];
    if (borrowedUsd > 0) {
      for (const [asset, e] of perAsset) {
        if (e.collLtUnits <= 0 || e.collAmount <= 0) continue;
        const price = e.collUsd / e.collAmount;
        const otherColl = weightedLt - e.collLtUsd;
        const otherDebt = borrowedUsd - e.debtUsd;
        const denom = e.collLtUnits - e.debtAmount;
        const liq = denom > 0 ? (otherDebt - otherColl) / denom : null;
        const liquidationPrice = liq != null && liq > 0 ? liq : null;
        liquidations.push({
          addressId: p.addressId,
          market: p.market,
          chain: p.chain,
          asset,
          symbol: e.symbol,
          price,
          liquidationPrice,
          dropPct: liquidationPrice != null ? Math.max(0, 1 - liquidationPrice / price) : null,
        });
      }
      liquidations.sort((x, y) => (x.dropPct ?? Infinity) - (y.dropPct ?? Infinity));
    }
    const net = suppliedUsd - borrowedUsd;
    const annual = ratesKnown ? supplyInterest - borrowInterest : null;
    out.set(k, {
      supplyApy: ratesKnown && suppliedUsd > 0 ? supplyInterest / suppliedUsd : null,
      borrowApy: ratesKnown && borrowedUsd > 0 ? borrowInterest / borrowedUsd : null,
      netApy: annual != null && net > 0 ? annual / net : null,
      ltvUsed: borrowedUsd > 0 && borrowPower > 0 ? borrowedUsd / borrowPower : null,
      liquidations,
      annualYieldUsd: annual,
      borrowPowerUsd: borrowPower,
      computedHf: borrowedUsd > 0 ? weightedLt / borrowedUsd : null,
    });
  }
  return out;
}

/** Positions with their rate / liquidation fields filled in. */
export function withPositionRisk(positions: AavePositionSummary[], risks: Map<string, PositionRisk>): AavePositionSummary[] {
  return positions.map((p) => {
    const r = risks.get(`${p.addressId}|${p.market}`);
    return {
      ...p,
      supplyApy: r?.supplyApy ?? null,
      borrowApy: r?.borrowApy ?? null,
      netApy: r?.netApy ?? null,
      ltvUsed: r?.ltvUsed ?? null,
      liquidations: r?.liquidations ?? [],
    };
  });
}

export interface RiskInput {
  totals: Totals;
  balances: BalanceRow[];
  tokens: TokenMap;
  /** rows hidden in the UI (spam / unpriced) are left out of exposure and stable share */
  isHidden: (b: BalanceRow) => boolean;
  positions: AavePositionSummary[];
  risks: Map<string, PositionRisk>;
  history: ScopeHistory;
}

export function riskSummary(i: RiskInput): RiskSummary {
  const { totals } = i;
  // Aave aggregates over positions that have rates
  let supplied = 0;
  let borrowed = 0;
  let supplyInt = 0;
  let borrowInt = 0;
  let power = 0;
  let debtAll = 0;
  let anyUnknown = false;
  let anyKnown = false;
  const liquidations: LiquidationPoint[] = [];
  for (const p of i.positions) {
    const r = i.risks.get(`${p.addressId}|${p.market}`);
    debtAll += p.borrowedUsd;
    if (!r || r.annualYieldUsd == null) {
      anyUnknown = true;
      continue;
    }
    anyKnown = true;
    supplied += p.suppliedUsd;
    borrowed += p.borrowedUsd;
    if (r.supplyApy != null) supplyInt += p.suppliedUsd * r.supplyApy;
    if (r.borrowApy != null) borrowInt += p.borrowedUsd * r.borrowApy;
    power += r.borrowPowerUsd ?? 0;
    liquidations.push(...r.liquidations);
  }
  liquidations.sort((x, y) => (x.dropPct ?? Infinity) - (y.dropPct ?? Infinity));
  const annual = anyKnown && !anyUnknown ? supplyInt - borrowInt : null;
  const aaveNet = supplied - borrowed;

  // net exposure per canonical asset (wallet + supplied - borrowed)
  const exp = new Map<string, NetExposure>();
  let stableGross = 0;
  for (const b of i.balances) {
    if (i.isHidden(b)) continue;
    const key = canonicalKey(i.tokens, b.chain, b.token);
    const symbol = underlyingSymbol(i.tokens, b.chain, b.token);
    const asset = assetOf(key, symbol);
    let e = exp.get(asset);
    if (!e) {
      e = { asset, symbol: assetSymbol(asset, symbol), amount: 0, usd: 0 };
      exp.set(asset, e);
    }
    e.amount += b.side === 'borrow' ? -b.amount : b.amount;
    e.usd += b.usd;
    if (asset === 'USD' && b.usd > 0) stableGross += b.usd;
  }
  const netExposure = [...exp.values()].filter((e) => Math.abs(e.usd) >= 0.01).sort((x, y) => Math.abs(y.usd) - Math.abs(x.usd));

  const ath = athOf(i.history);
  const athUsd = ath && ath.usd > 0 ? ath : null;
  return {
    leverage: totals.netUsd > 0 ? totals.assetsUsd / totals.netUsd : null,
    ltvUsed: anyKnown && !anyUnknown && debtAll > 0 && power > 0 ? debtAll / power : null,
    supplyApy: anyKnown && supplied > 0 ? supplyInt / supplied : null,
    borrowApy: anyKnown && borrowed > 0 ? borrowInt / borrowed : null,
    netApy: annual != null && aaveNet > 0 ? annual / aaveNet : null,
    annualYieldUsd: annual,
    liquidation: liquidations.find((l) => l.dropPct != null) ?? null,
    liquidations,
    netExposure,
    stableShare: totals.assetsUsd > 0 ? stableGross / totals.assetsUsd : null,
    ath: athUsd,
    drawdownPct: athUsd ? Math.min(0, (totals.netUsd - athUsd.usd) / athUsd.usd) : null,
  };
}
