// Current-state read models: overview, wallet view, address view, wallet / address summaries.
import type {
  AaveSummary,
  AddressDetailResponse,
  AddressSummary,
  Breakdown,
  Chain,
  OverviewResponse,
  ProtocolPosition,
  TokenRow,
  TopToken,
  Totals,
  WalletDetailResponse,
  WalletSummary,
  WalletWithAddresses,
} from './api-types';
import { type QDb, get, nowSec } from './db';
import { curvePositionInfos } from '../protocols/curve-crvusd';
import type { Db } from '../history/types';
import type { CurvePositionInfo } from './api-types';
import { backfillProgress, emptyBackfill, jobsSummary } from './jobs';
import { getFlowSummary } from './flows';
import { loadFx } from './fx';
import { loadScopeHistory, pnlSummary } from './pnl';
import { loadScopeYield, windowYield } from './yield';
import { type ReserveStates, loadReserveStates, positionRisks, riskSummary, withPositionRisk } from './risk';
import {
  CANONICAL_LABELS,
  CHAIN_LABELS,
  PROTOCOL_LABELS,
  looksSpam,
  marketChain,
  normalizeHealthFactor,
} from './meta';
import {
  type AddressRow,
  type WalletRow,
  getAddressByHex,
  getWallet,
  listAddresses,
  listWalletAddresses,
  listWallets,
  overallAddressIds,
  walletAddressIds,
  walletLinks,
} from './scope';
import {
  type AaveAccountRow,
  type BalanceRow,
  type SliceRef,
  type TokenMap,
  canonicalKey,
  change24h,
  changesFor,
  lastSnapshotAt,
  latestPrices,
  loadTokens,
  sliceAaveAccounts,
  sliceBalances,
  slicesAt,
  sliceValues,
  tokenMeta,
} from './state';

// ---------- current state ----------

export interface CurrentState {
  addressIds: number[];
  slices: SliceRef[];
  balances: BalanceRow[];
  aave: AaveAccountRow[];
  /** net usd per address (from position_values, falling back to balances) */
  usdByAddress: Map<number, number>;
  netUsd: number;
  tokens: TokenMap;
  prices: Map<string, number>;
}

export function currentState(db: QDb, addressIds: number[], now: number, tokens?: TokenMap): CurrentState {
  const tk = tokens ?? loadTokens(db);
  const slices = slicesAt(db, addressIds, now);
  const balances = sliceBalances(db, slices);
  const aave = sliceAaveAccounts(db, slices, marketChain);
  const pv = sliceValues(db, slices);
  const usdByAddress = new Map<number, number>();
  const pvSlices = new Set<string>();
  for (const r of pv) {
    usdByAddress.set(r.addressId, (usdByAddress.get(r.addressId) ?? 0) + r.usd);
    pvSlices.add(`${r.addressId}|${r.chain}`);
  }
  // slices without position_values rows (should not happen) fall back to their balances
  for (const b of balances) {
    if (pvSlices.has(`${b.addressId}|${b.chain}`)) continue;
    usdByAddress.set(b.addressId, (usdByAddress.get(b.addressId) ?? 0) + b.usd);
  }
  const keys = [...new Set(balances.map((b) => canonicalKey(tk, b.chain, b.token)))];
  return {
    addressIds,
    slices,
    balances,
    aave,
    usdByAddress,
    netUsd: [...usdByAddress.values()].reduce((s, v) => s + v, 0),
    tokens: tk,
    prices: latestPrices(db, keys),
  };
}

function isHidden(st: CurrentState, b: BalanceRow): boolean {
  const t = tokenMeta(st.tokens, b.chain, b.token);
  if (t?.spam) return true;
  if (b.side !== 'wallet') return false;
  if (looksSpam(t?.symbol, t?.name)) return true;
  // unpriced wallet tokens are hidden (value 0 and no known price)
  return b.usd === 0 && !st.prices.has(canonicalKey(st.tokens, b.chain, b.token));
}

export function totalsOf(st: CurrentState): Totals {
  let walletUsd = 0;
  let assetsUsd = 0;
  let debtUsd = 0;
  let protocolUsd = 0;
  for (const b of st.balances) {
    if (b.side === 'wallet') walletUsd += b.usd;
    else protocolUsd += b.usd;
    if (b.usd >= 0) assetsUsd += b.usd;
    else debtUsd += -b.usd;
  }
  return { netUsd: st.netUsd, assetsUsd, debtUsd, walletUsd, protocolUsd };
}

function withShares(items: { key: string; label: string; usd: number }[]): Breakdown[] {
  const pos = items.reduce((s, i) => s + Math.max(0, i.usd), 0);
  return items
    .map((i) => ({ ...i, share: pos > 0 ? i.usd / pos : 0 }))
    .sort((a, b) => b.usd - a.usd);
}

export function byChainOf(st: CurrentState, chains?: Chain[]): Breakdown[] {
  const m = new Map<string, number>();
  for (const c of chains ?? []) m.set(c, 0);
  for (const s of st.slices) if (!m.has(s.chain)) m.set(s.chain, 0);
  for (const b of st.balances) m.set(b.chain, (m.get(b.chain) ?? 0) + b.usd);
  return withShares([...m].map(([key, usd]) => ({ key, label: CHAIN_LABELS[key as Chain] ?? key, usd })));
}

export function byProtocolOf(st: CurrentState): Breakdown[] {
  const m = new Map<string, number>([['wallet', 0]]);
  for (const b of st.balances) m.set(b.protocol, (m.get(b.protocol) ?? 0) + b.usd);
  return withShares([...m].map(([key, usd]) => ({ key, label: PROTOCOL_LABELS[key] ?? key, usd })));
}

function displaySymbol(st: CurrentState, chain: Chain, token: string): { symbol: string; name: string | null; logo: string | null; decimals: number | null } {
  const t = tokenMeta(st.tokens, chain, token);
  if (t && (t.kind === 'atoken' || t.kind === 'vdebt' || t.kind === 'sdebt') && t.underlying) {
    const u = tokenMeta(st.tokens, chain, t.underlying);
    if (u?.symbol) return { symbol: u.symbol, name: u.name, logo: u.logo ?? t.logo, decimals: t.decimals };
  }
  return { symbol: t?.symbol ?? `${token.slice(0, 6)}...`, name: t?.name ?? null, logo: t?.logo ?? null, decimals: t?.decimals ?? null };
}

/** Aave markets of the current borrow rows (for loading their stored borrow rates). */
export function borrowMarkets(st: CurrentState): string[] {
  const out = new Set<string>();
  for (const b of st.balances) {
    if (b.side !== 'borrow') continue;
    const market = tokenMeta(st.tokens, b.chain, b.token)?.market;
    if (market) out.add(market);
  }
  return [...out];
}

/**
 * Tokens by canonical asset. heldAmount = wallet + supplied units, borrowedAmount = borrowed units,
 * borrowApy = stored variable borrow APY of the asset's reserve (weighted by borrowed USD when it is
 * borrowed in several markets), null when not borrowed or no rates are stored for it.
 */
export function topTokensOf(st: CurrentState, limit = 20, reserves?: ReserveStates): TopToken[] {
  const m = new Map<string, TopToken & { _chains: Set<Chain>; _apyUsd: number; _apySum: number }>();
  for (const b of st.balances) {
    if (isHidden(st, b)) continue;
    const key = canonicalKey(st.tokens, b.chain, b.token);
    let e = m.get(key);
    if (!e) {
      const canon = CANONICAL_LABELS[key];
      const d = displaySymbol(st, b.chain, b.token);
      e = {
        key,
        symbol: canon?.symbol ?? d.symbol,
        name: canon?.name ?? d.name,
        logo: d.logo,
        chains: [],
        amount: 0,
        price: st.prices.get(key) ?? null,
        usd: 0,
        walletUsd: 0,
        suppliedUsd: 0,
        borrowedUsd: 0,
        share: 0,
        heldAmount: 0,
        borrowedAmount: 0,
        borrowApy: null,
        _chains: new Set(),
        _apyUsd: 0,
        _apySum: 0,
      };
      m.set(key, e);
    }
    e._chains.add(b.chain);
    e.amount += b.side === 'borrow' ? -b.amount : b.amount;
    e.usd += b.usd;
    if (b.side === 'wallet') e.walletUsd += b.usd;
    else if (b.side === 'supply') e.suppliedUsd += b.usd;
    else e.borrowedUsd += -b.usd;
    if (b.side === 'borrow') {
      e.borrowedAmount = (e.borrowedAmount ?? 0) + b.amount;
      const t = tokenMeta(st.tokens, b.chain, b.token);
      const apy = t?.market ? reserves?.get(t.market)?.get((t.underlying ?? b.token).toLowerCase())?.borrowApy : null;
      if (apy != null) {
        // weight by borrowed usd; a dust row valued at $0 still counts with a tiny weight
        const w = Math.max(Math.abs(b.usd), 1e-12);
        e._apyUsd += w;
        e._apySum += w * apy;
      }
    } else e.heldAmount = (e.heldAmount ?? 0) + b.amount;
    if (!e.logo) e.logo = displaySymbol(st, b.chain, b.token).logo;
  }
  const list = [...m.values()].filter((e) => Math.abs(e.usd) >= 0.005 || e.walletUsd + e.suppliedUsd + e.borrowedUsd >= 0.005);
  const pos = list.reduce((s, e) => s + Math.max(0, e.usd), 0);
  return list
    .map(({ _chains, _apyUsd, _apySum, ...e }) => ({
      ...e,
      borrowApy: _apyUsd > 0 ? _apySum / _apyUsd : null,
      chains: [..._chains].sort(),
      price: e.price ?? (e.amount !== 0 ? Math.abs(e.usd / e.amount) : null),
      share: pos > 0 ? e.usd / pos : 0,
    }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, limit);
}

export function aaveSummaryOf(st: CurrentState, addresses: Map<number, AddressRow>): AaveSummary {
  const m = new Map<string, { addressId: number; market: string; chain: Chain; suppliedUsd: number; borrowedUsd: number }>();
  for (const b of st.balances) {
    // FRONTEND: Curve crvUSD / LlamaLend rows are reported in `curve`, not as Aave markets
    if (b.side === 'wallet' || b.protocol !== 'aave-v3') continue;
    const t = tokenMeta(st.tokens, b.chain, b.token);
    const market = t?.market ?? `${b.chain}-unknown`;
    const k = `${b.addressId}|${market}`;
    let e = m.get(k);
    if (!e) {
      e = { addressId: b.addressId, market, chain: b.chain, suppliedUsd: 0, borrowedUsd: 0 };
      m.set(k, e);
    }
    if (b.side === 'supply') e.suppliedUsd += b.usd;
    else e.borrowedUsd += -b.usd;
  }
  const hf = new Map(st.aave.map((a) => [`${a.addressId}|${a.market}`, a]));
  const positions = [...m.entries()]
    .filter(([, e]) => e.suppliedUsd >= 0.005 || e.borrowedUsd >= 0.005)
    .map(([k, e]) => {
      const a = addresses.get(e.addressId);
      const acct = hf.get(k);
      return {
        addressId: e.addressId,
        address: a?.address ?? '',
        label: a?.label ?? null,
        market: e.market,
        chain: e.chain,
        suppliedUsd: e.suppliedUsd,
        borrowedUsd: e.borrowedUsd,
        netUsd: e.suppliedUsd - e.borrowedUsd,
        healthFactor: e.borrowedUsd > 0 ? normalizeHealthFactor(acct?.healthFactor) : null,
      };
    })
    .sort((x, y) => y.suppliedUsd - x.suppliedUsd);
  const hfs = positions.map((p) => p.healthFactor).filter((v): v is number => v != null);
  const suppliedUsd = positions.reduce((s, p) => s + p.suppliedUsd, 0);
  const borrowedUsd = positions.reduce((s, p) => s + p.borrowedUsd, 0);
  return { suppliedUsd, borrowedUsd, netUsd: suppliedUsd - borrowedUsd, lowestHealthFactor: hfs.length ? Math.min(...hfs) : null, positions };
}

// ---------- summaries ----------

export function walletSummaries(db: QDb, now: number, st?: CurrentState): WalletSummary[] {
  const links = walletLinks(db);
  const wallets = listWallets(db);
  const allIds = [...new Set(wallets.flatMap((w) => walletAddressIds(db, w.id)))];
  const state = st && allIds.every((id) => st.addressIds.includes(id)) ? st : currentState(db, allIds, now);
  return wallets.map((w) => walletSummaryOf(db, w, walletAddressIds(db, w.id), links.byWallet.get(w.id)?.length ?? 0, state, now));
}

function walletSummaryOf(db: QDb, w: WalletRow, ids: number[], addressCount: number, st: CurrentState, now: number): WalletSummary {
  const usd = ids.reduce((s, id) => s + (st.usdByAddress.get(id) ?? 0), 0);
  return {
    id: w.id,
    name: w.name,
    color: w.color,
    sort: w.sort,
    excluded: w.excluded,
    createdAt: w.createdAt,
    addressCount,
    usd,
    change24h: change24h(db, ids, usd, now),
  };
}

export function addressSummaries(db: QDb, rows: AddressRow[], now: number, st?: CurrentState): AddressSummary[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const state = st && ids.every((id) => st.addressIds.includes(id)) ? st : currentState(db, ids, now);
  const links = walletLinks(db);
  const progress = backfillProgress(db, ids);
  return rows.map((r) => {
    const usd = state.usdByAddress.get(r.id) ?? 0;
    return {
      id: r.id,
      address: r.address,
      label: r.label,
      chains: r.chains,
      isContract: r.isContract,
      excluded: r.excluded,
      createdAt: r.createdAt,
      wallets: (links.byAddress.get(r.id) ?? []).map((w) => ({ id: w.id, name: w.name })),
      usd,
      change24h: change24h(db, [r.id], usd, now),
      lastSnapshotAt: lastSnapshotAt(state.slices.filter((s) => s.addressId === r.id)),
      backfill: progress.get(r.id) ?? emptyBackfill(),
    };
  });
}

// ---------- views ----------

/** FRONTEND: Curve loans of the current slices; [] when the Curve tables do not exist (tests, old DBs). */
function curveOf(db: QDb, slices: SliceRef[], addresses?: Map<number, AddressRow>): CurvePositionInfo[] {
  if (!get(db, "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'curve_positions'")) return [];
  try {
    return curvePositionInfos(db as unknown as Db, slices).map((c) => {
      const a = addresses?.get(c.addressId);
      return a ? { ...c, address: a.address, label: a.label } : c;
    });
  } catch {
    return [];
  }
}

function portfolioView(db: QDb, ids: number[], now: number, wallets: WalletSummary[]): OverviewResponse {
  const st = currentState(db, ids, now);
  const addresses = new Map(listAddresses(db).map((a) => [a.id, a]));
  const chains = [...new Set(ids.flatMap((id) => addresses.get(id)?.chains ?? []))];
  const totals = totalsOf(st);
  // one history load per request feeds every PnL window and the all-time high
  const history = loadScopeHistory(db, ids, st.tokens);
  const scopeYield = loadScopeYield(db, ids, history, st.tokens);
  const risks = positionRisks(db, st.balances, st.aave, st.tokens);
  const aave = aaveSummaryOf(st, addresses);
  aave.positions = withPositionRisk(aave.positions, risks);
  return {
    totals,
    change: changesFor(db, ids, st.netUsd, now),
    pnl: pnlSummary(history, now, {
      yieldIn: (from, to) => (scopeYield.pieces.length || scopeYield.gasKnown ? windowYield(scopeYield, from, to) : null),
      fx: loadFx(db),
    }),
    risk: riskSummary({
      totals,
      balances: st.balances,
      tokens: st.tokens,
      isHidden: (b) => isHidden(st, b),
      positions: aave.positions,
      risks,
      history,
    }),
    flows: getFlowSummary(db, ids),
    byChain: byChainOf(st, chains),
    byProtocol: byProtocolOf(st),
    byWallet: wallets,
    topTokens: topTokensOf(st, 20, loadReserveStates(db, borrowMarkets(st))),
    aave,
    curve: curveOf(db, st.slices, addresses),
    lastSnapshotAt: lastSnapshotAt(st.slices),
    jobs: jobsSummary(db, ids),
  };
}

export function getOverview(db: QDb, now = nowSec()): OverviewResponse {
  const ids = overallAddressIds(db);
  return portfolioView(db, ids, now, walletSummaries(db, now));
}

export function getWalletDetail(db: QDb, walletId: number, now = nowSec()): WalletDetailResponse | null {
  const w = getWallet(db, walletId);
  if (!w) return null;
  const ids = walletAddressIds(db, walletId);
  const rows = listWalletAddresses(db, walletId);
  const allIds = rows.map((r) => r.id);
  const st = currentState(db, allIds, now);
  const summary = walletSummaryOf(db, w, ids, rows.length, st, now);
  const view = portfolioView(db, ids, now, [summary]);
  return { ...view, wallet: summary, addresses: addressSummaries(db, rows, now, st) };
}

export function getWalletsWithAddresses(db: QDb, now = nowSec()): WalletWithAddresses[] {
  const rows = listAddresses(db);
  const st = currentState(db, rows.map((r) => r.id), now);
  const summaries = new Map(addressSummaries(db, rows, now, st).map((a) => [a.id, a]));
  const links = walletLinks(db);
  return walletSummaries(db, now, st).map((w) => ({
    ...w,
    addresses: (links.byWallet.get(w.id) ?? [])
      .map((id) => summaries.get(id))
      .filter((a): a is AddressSummary => !!a)
      .sort((a, b) => a.id - b.id),
  }));
}

function tokenRow(st: CurrentState, b: BalanceRow): TokenRow {
  const d = displaySymbol(st, b.chain, b.token);
  const t = tokenMeta(st.tokens, b.chain, b.token);
  const key = canonicalKey(st.tokens, b.chain, b.token);
  const known = st.prices.get(key);
  return {
    chain: b.chain,
    token: b.token,
    symbol: d.symbol,
    name: d.name,
    logo: d.logo,
    decimals: d.decimals,
    priceKey: key,
    price: known ?? (b.amount > 0 && b.usd !== 0 ? Math.abs(b.usd / b.amount) : null),
    amount: b.amount,
    amountRaw: b.amountRaw,
    usd: b.usd,
    spam: !!t?.spam || isHidden(st, b),
  };
}

export function getAddressDetail(db: QDb, address: string, now = nowSec()): AddressDetailResponse | null {
  const row = getAddressByHex(db, address);
  if (!row) return null;
  const st = currentState(db, [row.id], now);
  const [summary] = addressSummaries(db, [row], now, st);

  const walletTokens: TokenRow[] = [];
  const hidden: TokenRow[] = [];
  const protocols = new Map<string, ProtocolPosition>();
  for (const b of st.balances) {
    if (b.side === 'wallet') {
      if (b.amount === 0 && b.usd === 0) continue;
      (isHidden(st, b) ? hidden : walletTokens).push(tokenRow(st, b));
      continue;
    }
    const t = tokenMeta(st.tokens, b.chain, b.token);
    const market = t?.market ?? `${b.chain}-unknown`;
    let p = protocols.get(market);
    if (!p) {
      p = {
        protocol: b.protocol === 'curve-crvusd' || b.protocol === 'llamalend' ? b.protocol : 'aave-v3',
        market,
        chain: b.chain,
        supplied: [],
        borrowed: [],
        suppliedUsd: 0,
        borrowedUsd: 0,
        netUsd: 0,
        healthFactor: null,
        collateralUsd: null,
        debtUsd: null,
      };
      protocols.set(market, p);
    }
    const tr = tokenRow(st, b);
    if (b.side === 'supply') {
      p.supplied.push(tr);
      p.suppliedUsd += b.usd;
    } else {
      p.borrowed.push(tr);
      p.borrowedUsd += -b.usd;
    }
  }
  for (const a of st.aave) {
    const p = protocols.get(a.market);
    if (!p) continue;
    p.collateralUsd = a.collateralUsd;
    p.debtUsd = a.debtUsd;
    p.healthFactor = normalizeHealthFactor(a.healthFactor);
  }
  const protoList = [...protocols.values()]
    .map((p) => ({
      ...p,
      netUsd: p.suppliedUsd - p.borrowedUsd,
      healthFactor: p.borrowedUsd > 0 ? p.healthFactor : null,
      supplied: p.supplied.sort((x, y) => y.usd - x.usd),
      borrowed: p.borrowed.sort((x, y) => x.usd - y.usd),
    }))
    .filter((p) => p.supplied.length || p.borrowed.length)
    .sort((x, y) => y.netUsd - x.netUsd);

  walletTokens.sort((x, y) => y.usd - x.usd);
  const walletUsd = walletTokens.reduce((s, t) => s + t.usd, 0) + hidden.reduce((s, t) => s + t.usd, 0);
  return {
    address: summary,
    totals: totalsOf(st),
    change: changesFor(db, [row.id], st.netUsd, now),
    chains: byChainOf(st, row.chains),
    wallet: { usd: walletUsd, tokens: walletTokens },
    protocols: protoList,
    hidden: { count: hidden.length, tokens: hidden },
    curve: curveOf(db, st.slices),
    backfill: summary.backfill,
    lastSnapshotAt: lastSnapshotAt(st.slices),
  };
}
