// Curve crvUSD mint markets (Ethereum) and LlamaLend one-way lending markets (Ethereum, Arbitrum).
//
// Registry: every market of the crvUSD ControllerFactory and the OneWayLendingFactory is cached in
// `curve_markets` (migration 6) with a market key such as `eth-crvusd-3-weth` / `arb-llamalend-0-weth`.
// Each market also gets two pseudo token rows so the generic read models (token meta, canonical price
// key, market grouping) work without Curve specific code:
//   - (chain, AMM address): kind 'curve-collateral', symbol / decimals / price key of the collateral
//   - (chain, Controller address): kind 'curve-debt', symbol / decimals / price key of the borrowed token
// Balance rows (protocol 'curve-crvusd' for mint markets, 'llamalend' for lending markets):
//   - side 'supply', token = AMM: collateral units (user_state[0])
//   - side 'supply', token = Controller: borrowed token held in the AMM bands while in soft liquidation
//     (user_state[1], crvUSD for mint markets)
//   - side 'borrow', token = Controller: debt (user_state[2]), usd negative
// so the position's net value is collateral + soft-liquidation part - debt.
//
// Which (address, controller) pairs are read: only pairs found by `discoverCurvePairs` from the
// controllers' UserState(user, ...) logs (stored per (address, chain) in meta `history:curve:<id>:<chain>`
// together with the first event block). Addresses that never touched a Curve market cost no RPC.
//
// Health: Curve's health(user, true) is a fraction where 0 is the liquidation line (it already uses
// the liquidation discount, and `full` adds the value of collateral above the bands). It is NOT an Aave
// health factor; `curve_positions.health` stores it raw (fraction) and `healthToAaveLike` maps it to
// the Aave scale (1 + health: 1.0 = liquidation) for code that wants one comparable number.
import { decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseAbi, toEventSelector, type Hex } from 'viem';
import { histGetMeta, histRequestRedo, histSetMeta } from '../db/repos-history';
import { call, fetchTokenMeta } from '../history/aave';
import { multicallAt, type HistCall, type HistResult } from '../history/multicall';
import { canonicalPriceKey } from '../history/price-keys';
import type { CurvePositionInfo } from '../queries/api-types';
import { archiveRpc, logsRpc, toHex, type RpcPool } from '../history/rpc';
import { DAY, dayStart, type Db, type HistoryChain, type HistoryLogger } from '../history/types';

// ---------------------------------------------------------------------------------------------
// constants

export type CurveKind = 'mint' | 'lend';
export type CurveProtocol = 'curve-crvusd' | 'llamalend';

/** crvUSD ControllerFactory (mint markets). Ethereum only. */
export const CRVUSD_CONTROLLER_FACTORY = '0xc9332fdcb1c491dcc683bae86fe3cb70360738bc';

/** LlamaLend OneWayLendingFactory per chain. */
export const LLAMALEND_FACTORY: Record<HistoryChain, string> = {
  ethereum: '0xea6876dde9e3467564acbee1ed5bac88783205e0',
  arbitrum: '0xcaec110c784c9df37240a8ce096d352a75922dea',
};

export const CRVUSD_TOKEN: Record<HistoryChain, string> = {
  ethereum: '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
  arbitrum: '0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5',
};

export const CRVUSD_KEY = 'coingecko:crvusd';

/** Blocks before which no factory existed (log scans start here). */
const SCAN_FROM: Record<HistoryChain, number> = { ethereum: 17_257_000, arbitrum: 180_000_000 };

export const PROTOCOL_OF: Record<CurveKind, CurveProtocol> = { mint: 'curve-crvusd', lend: 'llamalend' };

export const USER_STATE_TOPIC = toEventSelector('UserState(address,uint256,uint256,int256,int256,uint256)');

const factoryAbi = parseAbi([
  'function n_collaterals() view returns (uint256)',
  'function market_count() view returns (uint256)',
  'function controllers(uint256) view returns (address)',
  'function amms(uint256) view returns (address)',
  'function vaults(uint256) view returns (address)',
  'function borrowed_tokens(uint256) view returns (address)',
  'function collateral_tokens(uint256) view returns (address)',
]);

const controllerAbi = parseAbi([
  'function collateral_token() view returns (address)',
  'function user_state(address user) view returns (uint256[4])',
  'function loan_exists(address user) view returns (bool)',
  'function health(address user, bool full) view returns (int256)',
  'function liquidation_discount() view returns (uint256)',
  'function loan_discount() view returns (uint256)',
]);

const ammAbi = parseAbi(['function rate() view returns (uint256)']);

// ---------------------------------------------------------------------------------------------
// registry

export interface CurveMarket {
  chain: HistoryChain;
  kind: CurveKind;
  idx: number;
  /** lowercase */
  controller: string;
  amm: string;
  vault: string | null;
  collateral: string;
  borrowed: string;
  collateralSymbol: string;
  borrowedSymbol: string;
  collateralDecimals: number;
  borrowedDecimals: number;
  collateralKey: string;
  borrowedKey: string;
  /** market key used in tokens.market and curve_positions.market */
  market: string;
  protocol: CurveProtocol;
}

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

export function curveMarketKey(chain: HistoryChain, kind: CurveKind, idx: number, collateralSymbol: string): string {
  const slug = collateralSymbol.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'x';
  return `${chain === 'ethereum' ? 'eth' : 'arb'}-${kind === 'mint' ? 'crvusd' : 'llamalend'}-${idx}-${slug}`;
}

/** Price key of a market token: crvUSD maps to coingecko:crvusd, factory-listed tokens are trusted. */
export function curveTokenPriceKey(chain: HistoryChain, token: string, symbol: string | null): string {
  const t = token.toLowerCase();
  if (t === CRVUSD_TOKEN[chain]) return CRVUSD_KEY;
  return canonicalPriceKey(chain, t, { symbol, trusted: true });
}

interface MarketRow {
  chain: string;
  kind: string;
  idx: number;
  controller: string;
  amm: string;
  vault: string | null;
  collateral: string;
  borrowed: string;
  collateral_symbol: string | null;
  borrowed_symbol: string | null;
  collateral_decimals: number;
  borrowed_decimals: number;
  collateral_key: string;
  borrowed_key: string;
  market: string;
}

function rowToMarket(r: MarketRow): CurveMarket {
  const kind = r.kind === 'lend' ? 'lend' : 'mint';
  return {
    chain: r.chain as HistoryChain,
    kind,
    idx: r.idx,
    controller: r.controller,
    amm: r.amm,
    vault: r.vault,
    collateral: r.collateral,
    borrowed: r.borrowed,
    collateralSymbol: r.collateral_symbol ?? '?',
    borrowedSymbol: r.borrowed_symbol ?? '?',
    collateralDecimals: r.collateral_decimals,
    borrowedDecimals: r.borrowed_decimals,
    collateralKey: r.collateral_key,
    borrowedKey: r.borrowed_key,
    market: r.market,
    protocol: PROTOCOL_OF[kind],
  };
}

/** Cached markets of a chain (no RPC). Empty before migration 6 or the first refresh. */
export function loadCurveMarkets(db: Db, chain: HistoryChain): CurveMarket[] {
  if (!hasTable(db, 'curve_markets')) return [];
  return (db.prepare('SELECT * FROM curve_markets WHERE chain = ? ORDER BY kind, idx').all(chain) as MarketRow[]).map(rowToMarket);
}

function upsertPseudoToken(
  db: Db,
  chain: HistoryChain,
  address: string,
  t: { symbol: string; name: string; decimals: number; kind: string; underlying: string; market: string; priceKey: string },
): void {
  db.prepare(
    `INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
     ON CONFLICT(chain, address) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
       kind = excluded.kind, underlying = excluded.underlying, market = excluded.market, price_key = excluded.price_key, spam = 0`,
  ).run(chain, address, t.symbol, t.name, t.decimals, t.kind, t.underlying, t.market, t.priceKey);
}

/** crvUSD token row with the coingecko key (discovery may have registered it with an address key). */
function ensureCrvUsdToken(db: Db, chain: HistoryChain): void {
  const a = CRVUSD_TOKEN[chain];
  db.prepare(
    `INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam)
     VALUES (?, ?, 'crvUSD', 'Curve.Fi USD Stablecoin', 18, 'erc20', NULL, NULL, ?, NULL, 0)
     ON CONFLICT(chain, address) DO UPDATE SET price_key = excluded.price_key, spam = 0`,
  ).run(chain, a, CRVUSD_KEY);
}

function insertMarket(db: Db, m: CurveMarket): void {
  db.prepare(
    `INSERT OR REPLACE INTO curve_markets (chain, controller, kind, idx, amm, vault, collateral, borrowed, collateral_symbol, borrowed_symbol,
       collateral_decimals, borrowed_decimals, collateral_key, borrowed_key, market)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.chain,
    m.controller,
    m.kind,
    m.idx,
    m.amm,
    m.vault,
    m.collateral,
    m.borrowed,
    m.collateralSymbol,
    m.borrowedSymbol,
    m.collateralDecimals,
    m.borrowedDecimals,
    m.collateralKey,
    m.borrowedKey,
    m.market,
  );
  const label = m.kind === 'mint' ? 'Curve crvUSD' : 'LlamaLend';
  upsertPseudoToken(db, m.chain, m.amm, {
    symbol: m.collateralSymbol,
    name: `${m.collateralSymbol} collateral (${label})`,
    decimals: m.collateralDecimals,
    kind: 'curve-collateral',
    underlying: m.collateral,
    market: m.market,
    priceKey: m.collateralKey,
  });
  upsertPseudoToken(db, m.chain, m.controller, {
    symbol: m.borrowedSymbol,
    name: `${m.borrowedSymbol} (${label} ${m.collateralSymbol})`,
    decimals: m.borrowedDecimals,
    kind: 'curve-debt',
    underlying: m.borrowed,
    market: m.market,
    priceKey: m.borrowedKey,
  });
}

/** Register one market (registry row, crvUSD token, AMM / Controller pseudo tokens) without RPC: demo data and tests. */
export function registerCurveMarket(db: Db, m: CurveMarket): void {
  ensureCrvUsdToken(db, m.chain);
  insertMarket(db, m);
}

const enc = (fn: 'n_collaterals' | 'market_count') => encodeFunctionData({ abi: factoryAbi, functionName: fn });
const encIdx = (fn: 'controllers' | 'amms' | 'vaults' | 'borrowed_tokens' | 'collateral_tokens', i: number) =>
  encodeFunctionData({ abi: factoryAbi, functionName: fn, args: [BigInt(i)] });

function decAddr(r: HistResult | undefined): string | null {
  if (!r?.success || r.data.length < 66) return null;
  const a = `0x${r.data.slice(26, 66)}`.toLowerCase();
  return /^0x0{40}$/.test(a) ? null : a;
}

function decNum(r: HistResult | undefined): number | null {
  if (!r?.success || r.data.length < 66) return null;
  return Number(BigInt(r.data.slice(0, 66)));
}

/**
 * Register markets added to the factories since the last refresh (reads at `block`). Returns the
 * number of new markets. A factory that cannot be read is skipped (the cached list stays usable).
 */
export async function refreshCurveMarkets(db: Db, chain: HistoryChain, rpc: RpcPool, block: number, log: HistoryLogger, signal?: AbortSignal): Promise<number> {
  if (!hasTable(db, 'curve_markets')) return 0;
  ensureCrvUsdToken(db, chain);
  const known = loadCurveMarkets(db, chain);
  const have = (kind: CurveKind) => new Set(known.filter((m) => m.kind === kind).map((m) => m.idx));
  const sources: { kind: CurveKind; factory: string }[] = [{ kind: 'lend', factory: LLAMALEND_FACTORY[chain] }];
  if (chain === 'ethereum') sources.unshift({ kind: 'mint', factory: CRVUSD_CONTROLLER_FACTORY });
  const counts = await multicallAt(
    rpc,
    chain,
    block,
    sources.map((s) => call(s.factory, enc(s.kind === 'mint' ? 'n_collaterals' : 'market_count'))),
    signal,
  );
  let added = 0;
  for (const [si, s] of sources.entries()) {
    const n = decNum(counts[si]);
    if (n == null) {
      log.warn(`curve ${chain}: ${s.kind} factory count unreadable at ${block}`);
      continue;
    }
    const seen = have(s.kind);
    const todo = Array.from({ length: n }, (_, i) => i).filter((i) => !seen.has(i));
    if (!todo.length) continue;
    const fns = s.kind === 'mint' ? (['controllers', 'amms'] as const) : (['controllers', 'amms', 'vaults', 'borrowed_tokens', 'collateral_tokens'] as const);
    const res = await multicallAt(
      rpc,
      chain,
      block,
      todo.flatMap((i) => fns.map((f) => call(s.factory, encIdx(f, i)))),
      signal,
    );
    const partial = todo.map((idx, j) => {
      const r = (k: number) => decAddr(res[j * fns.length + k]);
      return { idx, controller: r(0), amm: r(1), vault: s.kind === 'lend' ? r(2) : null, borrowed: s.kind === 'lend' ? r(3) : CRVUSD_TOKEN[chain], collateral: s.kind === 'lend' ? r(4) : null };
    });
    // mint markets: the collateral comes from the controller
    if (s.kind === 'mint') {
      const cr = await multicallAt(
        rpc,
        chain,
        block,
        partial.map((p) => call(p.controller ?? '0x0000000000000000000000000000000000000000', encodeFunctionData({ abi: controllerAbi, functionName: 'collateral_token' }))),
        signal,
      );
      partial.forEach((p, j) => (p.collateral = decAddr(cr[j])));
    }
    const tokens = [...new Set(partial.flatMap((p) => [p.collateral, p.borrowed]).filter((t): t is string => !!t))];
    const meta = await fetchTokenMeta(rpc, chain, block, tokens, signal);
    db.transaction(() => {
      for (const p of partial) {
        if (!p.controller || !p.amm || !p.collateral || !p.borrowed) {
          log.warn(`curve ${chain}: ${s.kind} market ${p.idx} incomplete at ${block}, skipped`);
          continue;
        }
        const cm = meta.get(p.collateral);
        const bm = meta.get(p.borrowed);
        if (cm?.decimals == null || bm?.decimals == null) {
          log.warn(`curve ${chain}: ${s.kind} market ${p.idx} token decimals unreadable, skipped`);
          continue;
        }
        const collateralSymbol = cm.symbol ?? p.collateral.slice(0, 8);
        const borrowedSymbol = bm.symbol ?? p.borrowed.slice(0, 8);
        insertMarket(db, {
          chain,
          kind: s.kind,
          idx: p.idx,
          controller: p.controller,
          amm: p.amm,
          vault: p.vault,
          collateral: p.collateral,
          borrowed: p.borrowed,
          collateralSymbol,
          borrowedSymbol,
          collateralDecimals: cm.decimals,
          borrowedDecimals: bm.decimals,
          collateralKey: curveTokenPriceKey(chain, p.collateral, collateralSymbol),
          borrowedKey: curveTokenPriceKey(chain, p.borrowed, borrowedSymbol),
          market: curveMarketKey(chain, s.kind, p.idx, collateralSymbol),
          protocol: PROTOCOL_OF[s.kind],
        });
        added++;
      }
    })();
  }
  if (added) log.info(`curve ${chain}: registered ${added} crvUSD / LlamaLend markets`);
  return added;
}

// ---------------------------------------------------------------------------------------------
// ledger hint

export interface CurveContractInfo {
  protocol: CurveProtocol;
  role: 'controller' | 'amm' | 'vault' | 'factory';
  /** market key, null for factories */
  market: string | null;
  collateralSymbol: string | null;
}

/**
 * Lowercase address -> role of every known crvUSD / LlamaLend contract on `chain` (controllers,
 * AMMs, vaults, factories). For the ledger classifier: a tx touching a controller / AMM is a Curve
 * loan action ('curve-borrow' etc.). Reads the cached registry only (no RPC).
 */
export function curveContracts(db: Db, chain: HistoryChain): Map<string, CurveContractInfo> {
  const out = new Map<string, CurveContractInfo>();
  if (chain === 'ethereum') out.set(CRVUSD_CONTROLLER_FACTORY, { protocol: 'curve-crvusd', role: 'factory', market: null, collateralSymbol: null });
  out.set(LLAMALEND_FACTORY[chain], { protocol: 'llamalend', role: 'factory', market: null, collateralSymbol: null });
  for (const m of loadCurveMarkets(db, chain)) {
    const base = { protocol: m.protocol, market: m.market, collateralSymbol: m.collateralSymbol };
    out.set(m.controller, { ...base, role: 'controller' });
    out.set(m.amm, { ...base, role: 'amm' });
    if (m.vault) out.set(m.vault, { ...base, role: 'vault' });
  }
  return out;
}

/** Role of one address (see curveContracts), null when it is not a known Curve lending contract. */
export function curveContractInfo(db: Db, chain: HistoryChain, address: string): CurveContractInfo | null {
  return curveContracts(db, chain).get(address.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------------------------
// per-address pairs (discovery)

interface PairState {
  /** last block covered by the UserState log scan */
  lastBlock: number | null;
  /** controller (lowercase) -> first UserState block */
  pairs: Record<string, number>;
}

const pairKey = (addressId: number, chain: HistoryChain) => `history:curve:${addressId}:${chain}`;

export function getCurvePairs(db: Db, addressId: number, chain: HistoryChain): PairState {
  try {
    const v = histGetMeta(db, pairKey(addressId, chain));
    if (v) {
      const j = JSON.parse(v) as PairState;
      return { lastBlock: j.lastBlock ?? null, pairs: j.pairs ?? {} };
    }
  } catch {
    /* corrupt marker: rescan */
  }
  return { lastBlock: null, pairs: {} };
}

function setCurvePairs(db: Db, addressId: number, chain: HistoryChain, s: PairState): void {
  histSetMeta(db, pairKey(addressId, chain), JSON.stringify(s));
}

interface RawLog {
  address: string;
  blockNumber: Hex;
}

export interface CurvePairDiscovery {
  /** controllers seen for the first time in this run, with their first UserState block */
  newPairs: { controller: string; firstBlock: number }[];
  /** UTC day from which history must be rewritten (null when nothing new) */
  redoFromDay: number | null;
}

/**
 * Scan the UserState(user) logs of every known controller of `chain` from the last scanned block to
 * `head` and record new (address, controller) pairs. Full ranges go to the keyless full-range logs
 * endpoint first, then the archive pool; on failure nothing is advanced (retried next run).
 */
export async function discoverCurvePairs(
  db: Db,
  chain: HistoryChain,
  addr: { id: number; address: string },
  head: number,
  rpcLatest: RpcPool,
  log: HistoryLogger,
  signal?: AbortSignal,
): Promise<CurvePairDiscovery> {
  const markets = loadCurveMarkets(db, chain);
  const st = getCurvePairs(db, addr.id, chain);
  const out: CurvePairDiscovery = { newPairs: [], redoFromDay: null };
  if (!markets.length) return out;
  const from = st.lastBlock == null ? SCAN_FROM[chain] : st.lastBlock + 1;
  if (from > head) return out;
  const filter = {
    address: markets.map((m) => getAddress(m.controller)),
    topics: [USER_STATE_TOPIC, `0x000000000000000000000000${addr.address.slice(2).toLowerCase()}`],
    fromBlock: toHex(from),
    toBlock: toHex(head),
  };
  const pools = head - from > 200_000 ? [logsRpc(chain, log), archiveRpc(chain, log)] : [rpcLatest, logsRpc(chain, log)];
  let logs: RawLog[] | null = null;
  let lastErr: unknown = null;
  for (const p of pools) {
    try {
      logs = await p.request<RawLog[]>('eth_getLogs', [filter], signal, 3);
      break;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  if (!logs) throw new Error(`curve ${chain}: UserState log scan failed: ${String(lastErr).slice(0, 200)}`);
  for (const l of logs) {
    const c = l.address.toLowerCase();
    const b = Number(BigInt(l.blockNumber));
    const prev = st.pairs[c];
    if (prev == null) out.newPairs.push({ controller: c, firstBlock: b });
    if (prev == null || b < prev) st.pairs[c] = b;
  }
  // a pair found in this run may have several events: keep the earliest
  for (const p of out.newPairs) p.firstBlock = st.pairs[p.controller];
  st.lastBlock = head;
  setCurvePairs(db, addr.id, chain, st);
  if (out.newPairs.length) {
    const first = Math.min(...out.newPairs.map((p) => p.firstBlock));
    try {
      const b = await rpcLatest.request<{ timestamp: Hex }>('eth_getBlockByNumber', [toHex(first), false], signal);
      out.redoFromDay = dayStart(Number(BigInt(b.timestamp))) - DAY;
    } catch (e) {
      if (signal?.aborted) throw e;
      out.redoFromDay = 0;
    }
    log.info(`curve ${chain}: ${addr.address} has ${out.newPairs.length} new crvUSD / LlamaLend market(s)`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// valuation (pure)

export interface CurveRawState {
  collateralRaw: bigint;
  /** borrowed token in the AMM bands (soft liquidation) */
  stableRaw: bigint;
  debtRaw: bigint;
  /** health(user, true) as int256 (1e18 = 100%), null when unreadable / no loan */
  healthRaw: bigint | null;
}

export interface CurveBalanceRow {
  token: string;
  amountRaw: string;
  amount: number;
  usd: number;
  protocol: CurveProtocol;
  side: 'supply' | 'borrow';
}

export interface CurveValued {
  market: CurveMarket;
  rows: CurveBalanceRow[];
  collateral: number;
  stablecoin: number;
  debt: number;
  /** supplied usd (collateral + soft liquidation part), positive */
  collateralUsd: number;
  /** positive */
  debtUsd: number;
  /** collateralUsd - debtUsd */
  netUsd: number;
  /** Curve health as a fraction (0 = liquidation), null without a loan */
  health: number | null;
}

/** Decode a two's complement int256 word. */
export function decodeInt256(word: bigint): bigint {
  return word >= 1n << 255n ? word - (1n << 256n) : word;
}

/** Curve health (fraction, 0 = liquidation) to the Aave scale (1 = liquidation). */
export function healthToAaveLike(health: number | null): number | null {
  return health == null ? null : 1 + health;
}

function units(raw: bigint, decimals: number): number {
  return Number(formatUnits(raw, decimals));
}

/**
 * Balance rows and totals of one position. Prices are the USD prices of the collateral and the
 * borrowed token (null = unknown, valued at 0). Returns null when the position is empty.
 */
export function valueCurvePosition(m: CurveMarket, s: CurveRawState, collateralPx: number | null, borrowedPx: number | null): CurveValued | null {
  if (s.collateralRaw === 0n && s.stableRaw === 0n && s.debtRaw === 0n) return null;
  const collateral = units(s.collateralRaw, m.collateralDecimals);
  const stablecoin = units(s.stableRaw, m.borrowedDecimals);
  const debt = units(s.debtRaw, m.borrowedDecimals);
  const pc = collateralPx ?? 0;
  const pb = borrowedPx ?? 0;
  const rows: CurveBalanceRow[] = [];
  if (s.collateralRaw > 0n) rows.push({ token: m.amm, amountRaw: s.collateralRaw.toString(), amount: collateral, usd: collateral * pc, protocol: m.protocol, side: 'supply' });
  if (s.stableRaw > 0n) rows.push({ token: m.controller, amountRaw: s.stableRaw.toString(), amount: stablecoin, usd: stablecoin * pb, protocol: m.protocol, side: 'supply' });
  if (s.debtRaw > 0n) rows.push({ token: m.controller, amountRaw: s.debtRaw.toString(), amount: debt, usd: -debt * pb, protocol: m.protocol, side: 'borrow' });
  const collateralUsd = collateral * pc + stablecoin * pb;
  const debtUsd = debt * pb;
  return {
    market: m,
    rows,
    collateral,
    stablecoin,
    debt,
    collateralUsd,
    debtUsd,
    netUsd: collateralUsd - debtUsd,
    health: s.debtRaw > 0n && s.healthRaw != null ? Number(s.healthRaw) / 1e18 : null,
  };
}

/** Position value per protocol of several valued positions (for position_values rows). */
export function curveProtocolTotals(vals: CurveValued[]): { protocol: CurveProtocol; usd: number }[] {
  const m = new Map<CurveProtocol, number>();
  for (const v of vals) m.set(v.market.protocol, (m.get(v.market.protocol) ?? 0) + v.netUsd);
  return [...m].map(([protocol, usd]) => ({ protocol, usd }));
}

/** Per-second rate (1e18) to APY with per second compounding. */
export function rateToApy(ratePerSec: bigint): number {
  return Math.expm1((Number(ratePerSec) / 1e18) * 365 * 86_400);
}

// ---------------------------------------------------------------------------------------------
// point read (live and history)

export interface CurvePointAddr {
  /** index into the caller's address list */
  a: number;
  addressId: number;
  address: string;
}

export interface CurvePointRead {
  /** per caller address index: raw states of its positions */
  states: { a: number; addressId: number; market: CurveMarket; state: CurveRawState; borrowApy: number | null }[];
  /** price keys of every non-empty position (collateral + borrowed) */
  priceKeys: string[];
}

const encUserState = (u: string) => encodeFunctionData({ abi: controllerAbi, functionName: 'user_state', args: [u as Hex] });
const encLoanExists = (u: string) => encodeFunctionData({ abi: controllerAbi, functionName: 'loan_exists', args: [u as Hex] });
const encHealth = (u: string) => encodeFunctionData({ abi: controllerAbi, functionName: 'health', args: [u as Hex, true] });
const encRate = () => encodeFunctionData({ abi: ammAbi, functionName: 'rate' });

/**
 * Read every discovered (address, controller) pair at `block` in ONE multicall: user_state,
 * loan_exists, health(user, true) and (with `rates`) the AMM's borrow rate. Pairs whose first
 * UserState event is after `block` are skipped. Returns null when there is nothing to read.
 * A failed user_state for a pair that already existed is an RPC-side failure: throw so the point is
 * retried instead of losing the position.
 */
export async function readCurvePoint(
  db: Db,
  chain: HistoryChain,
  rpc: RpcPool,
  block: number,
  addrs: CurvePointAddr[],
  opts: { rates?: boolean; signal?: AbortSignal } = {},
): Promise<CurvePointRead | null> {
  const byController = new Map(loadCurveMarkets(db, chain).map((m) => [m.controller, m]));
  if (!byController.size) return null;
  const pairs: { p: CurvePointAddr; m: CurveMarket }[] = [];
  for (const p of addrs) {
    const st = getCurvePairs(db, p.addressId, chain);
    for (const [c, first] of Object.entries(st.pairs)) {
      const m = byController.get(c);
      if (m && first <= block) pairs.push({ p, m });
    }
  }
  if (!pairs.length) return null;
  const calls: HistCall[] = [];
  for (const { p, m } of pairs) {
    calls.push(call(m.controller, encUserState(p.address)), call(m.controller, encLoanExists(p.address)), call(m.controller, encHealth(p.address)));
    if (opts.rates) calls.push(call(m.amm, encRate()));
  }
  const res = await multicallAt(rpc, chain, block, calls, opts.signal);
  const per = opts.rates ? 4 : 3;
  const out: CurvePointRead = { states: [], priceKeys: [] };
  const keys = new Set<string>();
  pairs.forEach(({ p, m }, i) => {
    const us = res[i * per];
    if (!us?.success) throw new Error(`curve user_state failed on ${m.market} at block ${block}`);
    if (us.data.length < 2 + 64 * 4) return; // no code yet (pair event before the read block cannot happen, but stay safe)
    const [collateralRaw, stableRaw, debtRaw] = decodeFunctionResult({ abi: controllerAbi, functionName: 'user_state', data: us.data }) as readonly bigint[];
    const exists = res[i * per + 1];
    const loan = !!exists?.success && exists.data.length >= 66 && BigInt(exists.data.slice(0, 66)) !== 0n;
    const h = res[i * per + 2];
    const healthRaw = loan && h?.success && h.data.length >= 66 ? decodeInt256(BigInt(h.data.slice(0, 66))) : null;
    if (collateralRaw === 0n && stableRaw === 0n && debtRaw === 0n) return;
    const r = opts.rates ? res[i * per + 3] : undefined;
    const borrowApy = r?.success && r.data.length >= 66 ? rateToApy(BigInt(r.data.slice(0, 66))) : null;
    out.states.push({ a: p.a, addressId: p.addressId, market: m, state: { collateralRaw, stableRaw, debtRaw, healthRaw }, borrowApy });
    keys.add(m.collateralKey);
    keys.add(m.borrowedKey);
  });
  out.priceKeys = [...keys];
  return out;
}

/**
 * Value a point read. `price(key)` returns the USD price or null (unknown). crvUSD without a price is
 * valued at $1 (a missing stablecoin price would otherwise turn the debt into $0 and inflate net
 * worth); any other missing key is reported through `onMissing`.
 */
export function valueCurvePoint(
  read: CurvePointRead,
  price: (key: string, a: number) => number | null,
  onMissing?: (key: string, a: number) => void,
): { a: number; addressId: number; valued: CurveValued; borrowApy: number | null }[] {
  const out: { a: number; addressId: number; valued: CurveValued; borrowApy: number | null }[] = [];
  const px = (key: string, a: number): number | null => {
    const p = price(key, a);
    if (p != null && p > 0) return p;
    if (key === CRVUSD_KEY) return 1;
    onMissing?.(key, a);
    return null;
  };
  for (const s of read.states) {
    const v = valueCurvePosition(s.market, s.state, px(s.market.collateralKey, s.a), px(s.market.borrowedKey, s.a));
    if (v) out.push({ a: s.a, addressId: s.addressId, valued: v, borrowApy: s.borrowApy });
  }
  return out;
}

/** Price keys needed to value the discovered pairs of these addresses (for price history sync). */
export function curvePriceKeys(db: Db, chain: HistoryChain, addressIds: number[]): string[] {
  const byController = new Map(loadCurveMarkets(db, chain).map((m) => [m.controller, m]));
  const keys = new Set<string>();
  for (const id of addressIds) {
    for (const c of Object.keys(getCurvePairs(db, id, chain).pairs)) {
      const m = byController.get(c);
      if (m) keys.add(m.collateralKey).add(m.borrowedKey);
    }
  }
  return [...keys];
}

/** True for the pseudo position tokens (AMM / Controller) that must never be valued as wallet tokens. */
export function isCurvePositionKind(kind: string | null | undefined): boolean {
  return kind === 'curve-collateral' || kind === 'curve-debt';
}

// ---------------------------------------------------------------------------------------------
// detail rows (curve_positions)

/**
 * Replace the Curve detail rows of (snapshot, address, chain) for the given addresses and drop rows of
 * snapshots that no longer exist (rollup / retention deletes snapshots without knowing this table).
 */
export function writeCurvePositions(
  db: Db,
  snapshotId: number,
  chain: HistoryChain,
  addressIds: number[],
  vals: { addressId: number; valued: CurveValued; borrowApy: number | null }[],
): void {
  if (!hasTable(db, 'curve_positions')) return;
  const del = db.prepare('DELETE FROM curve_positions WHERE snapshot_id = ? AND address_id = ? AND chain = ?');
  const ins = db.prepare(
    `INSERT OR REPLACE INTO curve_positions (snapshot_id, address_id, chain, market, controller, protocol, collateral, stablecoin, debt,
       collateral_usd, debt_usd, health, borrow_apy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const id of addressIds) del.run(snapshotId, id, chain);
    for (const v of vals) {
      const m = v.valued.market;
      ins.run(snapshotId, v.addressId, chain, m.market, m.controller, m.protocol, v.valued.collateral, v.valued.stablecoin, v.valued.debt, v.valued.collateralUsd, v.valued.debtUsd, v.valued.health, v.borrowApy);
    }
    db.prepare('DELETE FROM curve_positions WHERE snapshot_id NOT IN (SELECT id FROM snapshots)').run();
  })();
}

export interface CurvePositionDetail {
  snapshotId: number;
  addressId: number;
  chain: HistoryChain;
  market: string;
  controller: string;
  protocol: CurveProtocol;
  collateral: number;
  stablecoin: number;
  debt: number;
  collateralUsd: number;
  debtUsd: number;
  health: number | null;
  borrowApy: number | null;
}

/** Detail rows of the given snapshots (for read models that want health / soft liquidation info). */
export function loadCurvePositions(db: Db, snapshotIds: number[], addressIds: number[]): CurvePositionDetail[] {
  if (!snapshotIds.length || !addressIds.length || !hasTable(db, 'curve_positions')) return [];
  const rows = db
    .prepare(
      `SELECT * FROM curve_positions WHERE snapshot_id IN (SELECT value FROM json_each(?)) AND address_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(snapshotIds), JSON.stringify(addressIds)) as {
    snapshot_id: number;
    address_id: number;
    chain: string;
    market: string;
    controller: string;
    protocol: string;
    collateral: number;
    stablecoin: number;
    debt: number;
    collateral_usd: number;
    debt_usd: number;
    health: number | null;
    borrow_apy: number | null;
  }[];
  return rows.map((r) => ({
    snapshotId: r.snapshot_id,
    addressId: r.address_id,
    chain: r.chain as HistoryChain,
    market: r.market,
    controller: r.controller,
    protocol: r.protocol === 'llamalend' ? 'llamalend' : 'curve-crvusd',
    collateral: r.collateral,
    stablecoin: r.stablecoin,
    debt: r.debt,
    collateralUsd: r.collateral_usd,
    debtUsd: r.debt_usd,
    health: r.health,
    borrowApy: r.borrow_apy,
  }));
}

/** Push valued positions into per-address slice entries (balance rows + one position value per protocol). */
export function applyCurveToEntries(
  entries: { balances: { token: string; amountRaw: string; amount: number; usd: number; protocol: string; side: 'wallet' | 'supply' | 'borrow' }[]; positions: { protocol: string; usd: number }[] }[],
  vals: { a: number; valued: CurveValued }[],
): void {
  entries.forEach((e, a) => {
    const mine = vals.filter((v) => v.a === a).map((v) => v.valued);
    for (const v of mine) e.balances.push(...v.rows);
    e.positions.push(...curveProtocolTotals(mine));
  });
}

/**
 * History planning: register new markets (at `block`) and scan the UserState logs of addresses that
 * were never scanned on this chain. A pair found for an address that already has history requests a
 * redo of its days from the first loan day (via histRequestRedo), so call this BEFORE reading the redo
 * markers / done days. Never throws (Curve problems must not block the regular backfill).
 */
export async function prepareCurveHistory(
  db: Db,
  chain: HistoryChain,
  addrs: { id: number; address: string }[],
  rpc: RpcPool,
  block: number,
  log: HistoryLogger,
  signal?: AbortSignal,
): Promise<void> {
  if (!hasTable(db, 'curve_markets') || !addrs.length) return;
  try {
    await refreshCurveMarkets(db, chain, rpc, block, log, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`curve ${chain}: market refresh failed, using cached markets`, { error: String(e).slice(0, 200) });
  }
  for (const a of addrs) {
    if (getCurvePairs(db, a.id, chain).lastBlock != null) continue;
    try {
      const r = await discoverCurvePairs(db, chain, a, block, rpc, log, signal);
      if (r.redoFromDay != null) histRequestRedo(db, a.id, chain, r.redoFromDay);
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn(`curve ${chain}: ${a.address} position scan failed, retried next run`, { error: String(e).slice(0, 200) });
    }
  }
}

/**
 * API rows (CurvePositionInfo, lib/queries/api-types.ts) for the given current slices: the Curve detail
 * stored with each (snapshot, address, chain) slice. For read models: pass `slicesAt(...)` of the scope.
 */
export function curvePositionInfos(db: Db, slices: { snapshotId: number; addressId: number; chain: string }[]): CurvePositionInfo[] {
  if (!slices.length) return [];
  const want = new Set(slices.map((s) => `${s.snapshotId}|${s.addressId}|${s.chain}`));
  const rows = loadCurvePositions(
    db,
    [...new Set(slices.map((s) => s.snapshotId))],
    [...new Set(slices.map((s) => s.addressId))],
  ).filter((r) => want.has(`${r.snapshotId}|${r.addressId}|${r.chain}`));
  if (!rows.length) return [];
  const markets = new Map<string, CurveMarket>();
  for (const c of new Set(rows.map((r) => r.chain))) for (const m of loadCurveMarkets(db, c)) markets.set(`${c}|${m.controller}`, m);
  return rows
    .map((r) => {
      const m = markets.get(`${r.chain}|${r.controller}`);
      return {
        addressId: r.addressId,
        chain: r.chain,
        protocol: r.protocol,
        market: r.market,
        collateralSymbol: m?.collateralSymbol ?? '?',
        borrowedSymbol: m?.borrowedSymbol ?? '?',
        collateral: r.collateral,
        stablecoin: r.stablecoin,
        debt: r.debt,
        collateralUsd: r.collateralUsd,
        debtUsd: r.debtUsd,
        health: r.health,
        healthFactorLike: healthToAaveLike(r.health),
        softLiquidation: r.stablecoin > 0,
        borrowApy: r.borrowApy,
      };
    })
    .sort((x, y) => y.debtUsd - x.debtUsd);
}
