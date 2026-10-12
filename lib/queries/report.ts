// Bot report (GET /api/bot/report): what changed in a scope over a window, compact enough to hand to
// an LLM. Reuses the overview read models for the current state and replays them at the window start.
import type {
  BotReportResponse,
  Chain,
  DisplayCurrency,
  ReportAlert,
  ReportHolding,
  ReportPosition,
  ReportTx,
  ReportWindow,
  TopToken,
  TxKind,
  TxRow,
} from './api-types';
import { type QDb, nowSec } from './db';
import { loadFx } from './fx';
import { jobsSummary } from './jobs';
import { DAY, HOUR } from './meta';
import { getHealth } from './misc';
import { loadScopeHistory, pnlPeriod } from './pnl';
import { aaveSummaryOf, borrowMarkets, curveOf, currentState, isHidden, topTokensOf, totalsOf } from './portfolio';
import { loadReserveStates, positionRisks, riskSummary, withPositionRisk } from './risk';
import { listAddresses } from './scope';
import { lastSnapshotAt } from './state';
import { getTransactions } from './transactions';
import { loadScopeYield, windowYield } from './yield';

export const REPORT_WINDOWS: Record<ReportWindow, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };

const MAX_HOLDINGS = 25;
const MAX_TX = 50;
const STALE_AFTER = HOUR;

export interface ReportQuery {
  addressIds: number[];
  scope: string;
  window: ReportWindow;
  currency: DisplayCurrency;
}

export function getReport(db: QDb, q: ReportQuery, now = nowSec()): BotReportResponse {
  const ids = q.addressIds;
  const stNow = currentState(db, ids, now);
  const history = loadScopeHistory(db, ids, stNow.tokens);
  // like the overview PnL windows: start at now - window, or later when the history starts later
  const from = Math.max(now - REPORT_WINDOWS[q.window], history.earliest ?? -Infinity);
  const stThen = currentState(db, ids, from, stNow.tokens);
  const addresses = new Map(listAddresses(db).map((a) => [a.id, a]));

  const scopeYield = loadScopeYield(db, ids, history, stNow.tokens);
  const pnl = pnlPeriod(history, q.window, from, Infinity, {
    yieldIn: (f, t) => (scopeYield.pieces.length || scopeYield.gasKnown ? windowYield(scopeYield, f, t) : null),
    fx: loadFx(db),
  });

  const totals = totalsOf(stNow);
  const risks = positionRisks(db, stNow.balances, stNow.aave, stNow.tokens);
  const aaveNow = aaveSummaryOf(stNow, addresses);
  aaveNow.positions = withPositionRisk(aaveNow.positions, risks);
  const risk = riskSummary({
    totals,
    balances: stNow.balances,
    tokens: stNow.tokens,
    isHidden: (b) => isHidden(stNow, b),
    positions: aaveNow.positions,
    risks,
    history,
  });

  const holdings = holdingChanges(
    topTokensOf(stThen, Infinity),
    topTokensOf(stNow, Infinity, loadReserveStates(db, borrowMarkets(stNow))),
  );

  const hfStart = new Map(aaveSummaryOf(stThen, addresses).positions.map((p) => [`${p.addressId}|${p.market}`, p.healthFactor]));
  const positions: ReportPosition[] = aaveNow.positions.map((p) => ({
    protocol: 'aave-v3',
    market: p.market,
    chain: p.chain,
    address: p.address,
    label: p.label,
    collateralUsd: p.suppliedUsd,
    debtUsd: p.borrowedUsd,
    healthFactor: p.healthFactor,
    healthFactorStart: hfStart.get(`${p.addressId}|${p.market}`) ?? null,
    liquidationDropPct: p.liquidations?.[0]?.dropPct ?? null,
  }));
  const curveStart = new Map(curveOf(db, stThen.slices).map((c) => [`${c.addressId}|${c.market}`, c.debt > 0 ? c.healthFactorLike : null]));
  for (const c of curveOf(db, stNow.slices, addresses)) {
    positions.push({
      protocol: c.protocol,
      market: c.market,
      chain: c.chain,
      address: c.address ?? addresses.get(c.addressId)?.address ?? '',
      label: c.label ?? addresses.get(c.addressId)?.label ?? null,
      collateralUsd: c.collateralUsd,
      debtUsd: c.debtUsd,
      healthFactor: c.debt > 0 ? c.healthFactorLike : null,
      healthFactorStart: curveStart.get(`${c.addressId}|${c.market}`) ?? null,
      liquidationDropPct: null,
      softLiquidation: c.softLiquidation,
    });
  }

  const activity = windowActivity(db, ids, from);
  const jobs = jobsSummary(db, ids);
  const last = lastSnapshotAt(stNow.slices);
  const freshness = {
    lastSnapshotAt: last,
    workerHeartbeatAt: getHealth(db, null).workerHeartbeatAt,
    stale: last == null || now - last > STALE_AFTER,
    backfillComplete: jobs.backfill.complete,
    failedJobs: jobs.failed,
  };

  const startUsd = pnl.startUsd;
  const netWorth = {
    startUsd,
    endUsd: stNow.netUsd,
    changeUsd: startUsd == null ? null : stNow.netUsd - startUsd,
    // a dust start (before the first deposit) gives a meaningless percentage
    changePct: startUsd != null && Math.abs(startUsd) >= 1 ? (stNow.netUsd - startUsd) / Math.abs(startUsd) : null,
    assetsUsd: totals.assetsUsd,
    debtUsd: totals.debtUsd,
  };

  const cp = q.currency !== 'USD' ? pnl.currencies?.[q.currency] : undefined;
  const currency: BotReportResponse['currency'] = cp
    ? { code: cp.currency, rateStart: cp.rateStart, rateEnd: cp.rateEnd, start: cp.start, end: cp.end, change: cp.change, market: cp.market, fxEffect: cp.fxEffect }
    : {
        code: 'USD',
        rateStart: 1,
        rateEnd: 1,
        start: startUsd,
        end: stNow.netUsd,
        change: netWorth.changeUsd,
        market: pnl.pnlUsd,
        fxEffect: startUsd == null ? null : 0,
      };

  return {
    generatedAt: now,
    scope: q.scope,
    window: q.window,
    from,
    to: now,
    freshness,
    netWorth,
    pnl,
    currency,
    holdings: holdings.slice(0, MAX_HOLDINGS),
    positions,
    risk: {
      leverage: risk.leverage,
      ltvUsed: risk.ltvUsed,
      netApy: risk.netApy,
      annualYieldUsd: risk.annualYieldUsd,
      stableShare: risk.stableShare,
      drawdownPct: risk.drawdownPct,
      ath: risk.ath,
    },
    activity,
    alerts: alertsOf({
      now,
      freshness,
      netWorth,
      positions,
      holdings,
      activity,
      fxMissing: q.currency !== 'USD' && !cp && pnl.fromTs != null,
      currency: q.currency,
    }),
  };
}

// ---------- holdings ----------

const EPS = 1e-9;

function sameUnits(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(EPS, 1e-6 * Math.max(Math.abs(a), Math.abs(b)));
}

/** USD per unit from the stored snapshot values, i.e. the price of that time (not today's). */
function unitPrice(t: TopToken | undefined): number | null {
  if (!t) return null;
  const held = t.heldAmount ?? 0;
  const borrowed = t.borrowedAmount ?? 0;
  if (held > EPS) return (t.walletUsd + t.suppliedUsd) / held;
  if (borrowed > EPS) return t.borrowedUsd / borrowed;
  return null;
}

/** Per canonical asset: units and value at the window start vs now, largest USD change first. */
export function holdingChanges(start: TopToken[], end: TopToken[]): ReportHolding[] {
  const s = new Map(start.map((t) => [t.key, t]));
  const e = new Map(end.map((t) => [t.key, t]));
  const out: ReportHolding[] = [];
  for (const key of new Set([...s.keys(), ...e.keys()])) {
    const a = s.get(key);
    const b = e.get(key);
    const heldStart = a?.heldAmount ?? 0;
    const heldEnd = b?.heldAmount ?? 0;
    const borrowedStart = a?.borrowedAmount ?? 0;
    const borrowedEnd = b?.borrowedAmount ?? 0;
    const priceStart = unitPrice(a);
    const priceEnd = b ? (b.price ?? unitPrice(b)) : null;
    const status: ReportHolding['status'] = !a
      ? 'new'
      : !b
        ? 'closed'
        : sameUnits(heldStart, heldEnd) && sameUnits(borrowedStart, borrowedEnd)
          ? 'price'
          : 'changed';
    const usdStart = a?.usd ?? 0;
    const usdEnd = b?.usd ?? 0;
    out.push({
      key,
      symbol: (b ?? a)!.symbol,
      chains: [...new Set<Chain>([...(a?.chains ?? []), ...(b?.chains ?? [])])].sort(),
      heldStart,
      heldEnd,
      borrowedStart,
      borrowedEnd,
      usdStart,
      usdEnd,
      usdChange: usdEnd - usdStart,
      priceStart,
      priceEnd,
      priceChangePct: priceStart != null && priceEnd != null && priceStart > 0 ? priceEnd / priceStart - 1 : null,
      status,
    });
  }
  return out.sort((x, y) => Math.abs(y.usdChange) - Math.abs(x.usdChange));
}

// ---------- activity ----------

function compactTx(r: TxRow): ReportTx {
  return {
    ts: r.ts,
    chain: r.chain,
    kind: r.kind,
    netUsd: r.netUsd,
    feeUsd: r.feeUsd,
    counterparty: r.counterparty,
    counterpartyLabel: r.counterpartyLabel,
    transfers: r.transfers.map((t) => ({ symbol: t.symbol, amount: t.amount, usd: t.usd, direction: t.direction })),
    explorerUrl: r.explorerUrl,
  };
}

function windowActivity(db: QDb, ids: number[], from: number): BotReportResponse['activity'] {
  const rows: TxRow[] = [];
  let cursor: string | null = null;
  let syncing = false;
  // newest first: page until the window start is passed (bounded, a busy month is a few hundred rows)
  for (let page = 0; page < 10; page++) {
    const r = getTransactions(db, { addressIds: ids, hideSpam: true, cursor, limit: 200, withFlows: false });
    syncing = r.syncing;
    let passed = false;
    for (const t of r.items) {
      if (t.ts < from) {
        passed = true;
        break;
      }
      rows.push(t);
    }
    if (passed || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  const byKind: Partial<Record<TxKind, number>> = {};
  for (const t of rows) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  return { count: rows.length, byKind, items: rows.slice(0, MAX_TX).map(compactTx), truncated: rows.length > MAX_TX, syncing };
}

// ---------- alerts ----------

/** Plain USD for alert text, e.g. $1'234. Bots read these; the UI never renders them. */
function usd(v: number): string {
  const n = Math.round(Math.abs(v));
  return `${v < 0 ? '-' : ''}$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
}

export interface AlertInput {
  now: number;
  freshness: BotReportResponse['freshness'];
  netWorth: BotReportResponse['netWorth'];
  positions: ReportPosition[];
  holdings: ReportHolding[];
  activity: BotReportResponse['activity'];
  fxMissing: boolean;
  currency: DisplayCurrency;
}

export function alertsOf(i: AlertInput): ReportAlert[] {
  const out: ReportAlert[] = [];
  const f = i.freshness;
  if (f.stale) {
    const age = f.lastSnapshotAt == null ? 'no live snapshot yet' : `last live snapshot ${Math.round((i.now - f.lastSnapshotAt) / 60)} min ago`;
    out.push({ level: 'warning', code: 'data-stale', message: `Data may be outdated: ${age}. Check that the worker is running.` });
  }
  if (f.failedJobs > 0) out.push({ level: 'warning', code: 'jobs-failed', message: `${f.failedJobs} background job(s) failed.` });
  if (!f.backfillComplete) out.push({ level: 'info', code: 'backfill-running', message: 'History backfill is still running, older comparisons may be incomplete.' });
  if (i.activity.syncing) out.push({ level: 'info', code: 'ledger-syncing', message: 'Transaction ledger is still syncing, activity may be incomplete.' });
  if (i.fxMissing) out.push({ level: 'info', code: 'fx-missing', message: `No ${i.currency} rate stored yet, currency figures are in USD.` });

  for (const p of i.positions) {
    const name = `${p.protocol} ${p.market}${p.label ? ` (${p.label})` : ''}`;
    if (p.softLiquidation) {
      out.push({ level: 'critical', code: 'soft-liquidation', message: `${name} is in soft liquidation.` });
      continue;
    }
    const hf = p.healthFactor;
    if (hf == null) continue;
    const drop = p.liquidationDropPct;
    const dropText = drop != null ? `, liquidation after a ${(drop * 100).toFixed(0)}% price drop` : '';
    const was = p.healthFactorStart != null ? ` (was ${p.healthFactorStart.toFixed(2)})` : '';
    if (hf < 1.1 || (drop != null && drop < 0.1)) {
      out.push({ level: 'critical', code: 'health-factor-critical', message: `${name} health factor ${hf.toFixed(2)}${was}${dropText}.` });
    } else if (hf < 1.5 || (drop != null && drop < 0.25)) {
      out.push({ level: 'warning', code: 'health-factor-low', message: `${name} health factor ${hf.toFixed(2)}${was}${dropText}.` });
    } else if (p.healthFactorStart != null && p.healthFactorStart - hf >= 0.1) {
      out.push({ level: 'info', code: 'health-factor-down', message: `${name} health factor fell to ${hf.toFixed(2)}${was}.` });
    }
  }

  const nw = i.netWorth;
  if (nw.changePct != null && nw.changeUsd != null && Math.abs(nw.changePct) >= 0.05) {
    out.push({ level: 'info', code: 'net-worth-move', message: `Net worth ${pct(nw.changePct)} (${usd(nw.changeUsd)}) to ${usd(nw.endUsd)}.` });
  }

  const opened = i.holdings.filter((h) => h.status === 'new' && Math.abs(h.usdEnd) >= 1).map((h) => h.symbol);
  const closed = i.holdings.filter((h) => h.status === 'closed' && Math.abs(h.usdStart) >= 1).map((h) => h.symbol);
  if (opened.length) out.push({ level: 'info', code: 'holdings-new', message: `New holdings: ${opened.join(', ')}.` });
  if (closed.length) out.push({ level: 'info', code: 'holdings-closed', message: `No longer held: ${closed.join(', ')}.` });

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
