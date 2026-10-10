// Aave v3 helpers for historical reads (Pool proxy only, never the data provider).
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { histInsertTokenIfMissing, histListAaveTokens, histUpsertAaveToken, type HistTokenRow } from '../db/repos-history';
import { multicallAt, type HistCall, type HistResult } from './multicall';
import { canonicalPriceKey } from './price-keys';
import type { RpcPool } from './rpc';
import type { Db, HistoryChain, HistoryLogger } from './types';

export interface HistAaveMarket {
  key: string;
  chain: HistoryChain;
  pool: Hex;
}

export const HIST_AAVE_MARKETS: HistAaveMarket[] = [
  { key: 'eth-core', chain: 'ethereum', pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  { key: 'eth-prime', chain: 'ethereum', pool: '0x4e033931ad43597d96D6bcc25c280717730B58B1' },
  { key: 'eth-etherfi', chain: 'ethereum', pool: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0' },
  { key: 'eth-horizon', chain: 'ethereum', pool: '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8' },
  { key: 'arb-core', chain: 'arbitrum', pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
];

export function marketsForChain(chain: HistoryChain): HistAaveMarket[] {
  return HIST_AAVE_MARKETS.filter((m) => m.chain === chain);
}

export const poolAbi = parseAbi([
  'function getReservesList() view returns (address[])',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)',
  'struct RD { uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex; uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id; address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress; address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt; }',
  'function getReserveData(address asset) view returns (RD)',
]);

/** Pool reads for rates, risk parameters and eMode (live snapshot only). Version dependent calls are
 *  issued with allowFailure: getEModeCategoryData exists up to v3.1, the CollateralConfig / bitmap
 *  pair from v3.2 on. */
export const poolRiskAbi = parseAbi([
  'function getUserEMode(address user) view returns (uint256)',
  'function getUserConfiguration(address user) view returns (uint256)',
  'struct ECD { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; address priceSource; string label; }',
  'function getEModeCategoryData(uint8 id) view returns (ECD)',
  'struct ECC { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; }',
  'function getEModeCategoryCollateralConfig(uint8 id) view returns (ECC)',
  'function getEModeCategoryCollateralBitmap(uint8 id) view returns (uint128)',
]);

export interface ReserveRiskState {
  asset: string;
  reserveId: number;
  supplyApy: number;
  borrowApy: number;
  ltvBps: number;
  ltBps: number;
  /** eMode category from the configuration bitmap (bits 168-175, used by v3.0 / v3.1) */
  emodeCategory: number;
}

const RAY = 1e27;
const SECONDS_PER_YEAR = 31_536_000;

/** Aave ray rate (per year, linear) to APY with per-second compounding. */
export function rayToApy(rate: bigint): number {
  const r = Number(rate) / RAY;
  if (!Number.isFinite(r) || r <= 0) return 0;
  return Math.pow(1 + r / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1;
}

export function encReserveData(asset: string): Hex {
  return encodeFunctionData({ abi: poolAbi, functionName: 'getReserveData', args: [asset as Hex] });
}

export function decodeReserveRisk(asset: string, r: HistResult | undefined): ReserveRiskState | null {
  if (!r || !r.success || r.data.length < 66) return null;
  try {
    const d = decodeFunctionResult({ abi: poolAbi, functionName: 'getReserveData', data: r.data }) as {
      configuration: bigint;
      currentLiquidityRate: bigint;
      currentVariableBorrowRate: bigint;
      id: number;
    };
    const cfg = BigInt(d.configuration);
    return {
      asset: asset.toLowerCase(),
      reserveId: Number(d.id),
      supplyApy: rayToApy(BigInt(d.currentLiquidityRate)),
      borrowApy: rayToApy(BigInt(d.currentVariableBorrowRate)),
      ltvBps: Number(cfg & 0xffffn),
      ltBps: Number((cfg >> 16n) & 0xffffn),
      emodeCategory: Number((cfg >> 168n) & 0xffn),
    };
  } catch {
    return null;
  }
}

export function encUserEMode(user: string): Hex {
  return encodeFunctionData({ abi: poolRiskAbi, functionName: 'getUserEMode', args: [user as Hex] });
}

export function encUserConfiguration(user: string): Hex {
  return encodeFunctionData({ abi: poolRiskAbi, functionName: 'getUserConfiguration', args: [user as Hex] });
}

export function encEModeCalls(category: number): { data: Hex; collateral: Hex; bitmap: Hex } {
  return {
    data: encodeFunctionData({ abi: poolRiskAbi, functionName: 'getEModeCategoryData', args: [category] }),
    collateral: encodeFunctionData({ abi: poolRiskAbi, functionName: 'getEModeCategoryCollateralConfig', args: [category] }),
    bitmap: encodeFunctionData({ abi: poolRiskAbi, functionName: 'getEModeCategoryCollateralBitmap', args: [category] }),
  };
}

export interface EModeConfig {
  ltvBps: number;
  ltBps: number;
  /** v3.2+: bitmap of reserve ids usable as eMode collateral (decimal string); null on v3.0 / v3.1 */
  collateralBitmap: string | null;
}

/** Decode the eMode category from whichever call the Pool version answered. */
export function decodeEMode(data: HistResult | undefined, collateral: HistResult | undefined, bitmap: HistResult | undefined): EModeConfig | null {
  if (collateral?.success && collateral.data.length >= 2 + 64 * 3) {
    try {
      const c = decodeFunctionResult({ abi: poolRiskAbi, functionName: 'getEModeCategoryCollateralConfig', data: collateral.data }) as {
        ltv: number;
        liquidationThreshold: number;
      };
      const bm = bitmap?.success && bitmap.data.length >= 66 ? BigInt(bitmap.data.slice(0, 66)).toString() : null;
      if (c.liquidationThreshold > 0) return { ltvBps: Number(c.ltv), ltBps: Number(c.liquidationThreshold), collateralBitmap: bm };
    } catch {
      /* try the v3.0 / v3.1 call */
    }
  }
  if (data?.success && data.data.length >= 66) {
    try {
      const c = decodeFunctionResult({ abi: poolRiskAbi, functionName: 'getEModeCategoryData', data: data.data }) as {
        ltv: number;
        liquidationThreshold: number;
      };
      if (c.liquidationThreshold > 0) return { ltvBps: Number(c.ltv), ltBps: Number(c.liquidationThreshold), collateralBitmap: null };
    } catch {
      /* unknown layout */
    }
  }
  return null;
}

export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const erc20Bytes32Abi = parseAbi(['function symbol() view returns (bytes32)', 'function name() view returns (bytes32)']);

const ZERO = '0x0000000000000000000000000000000000000000';

export interface ReserveTokens {
  market: string;
  asset: string; // underlying, lowercase
  aToken: string;
  vDebt: string;
  sDebt: string | null;
  decimals: number;
  symbol: string;
  priceKey: string;
}

export function call(target: string, data: Hex): HistCall {
  return { kind: 'call', target: target as Hex, data };
}

export function encReservesList(): Hex {
  return encodeFunctionData({ abi: poolAbi, functionName: 'getReservesList' });
}

export function encAccountData(user: string): Hex {
  return encodeFunctionData({ abi: poolAbi, functionName: 'getUserAccountData', args: [user as Hex] });
}

export function encBalanceOf(user: string): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [user as Hex] });
}

export function decodeReservesList(r: HistResult | undefined): string[] | null {
  if (!r || !r.success || r.data.length < 130) return null;
  try {
    const v = decodeFunctionResult({ abi: poolAbi, functionName: 'getReservesList', data: r.data }) as readonly string[];
    return v.map((a) => a.toLowerCase());
  } catch {
    return null;
  }
}

export function decodeAccountData(
  r: HistResult | undefined,
): { collateralUsd: number; debtUsd: number; healthFactor: number | null; ltBps: number; ltvBps: number } | null {
  if (!r || !r.success || r.data.length < 2 + 64 * 6) return null;
  try {
    const v = decodeFunctionResult({ abi: poolAbi, functionName: 'getUserAccountData', data: r.data }) as readonly bigint[];
    const [coll, debt, , lt, ltv, hf] = v;
    return {
      collateralUsd: Number(coll) / 1e8,
      debtUsd: Number(debt) / 1e8,
      healthFactor: hf > 10n ** 30n ? null : Number(hf) / 1e18,
      // weighted averages over the user's collateral, basis points
      ltBps: Number(lt),
      ltvBps: Number(ltv),
    };
  } catch {
    return null;
  }
}

function decodeStr(r: HistResult | undefined, fn: 'symbol' | 'name'): string | null {
  if (!r || !r.success || r.data.length < 66) return null;
  try {
    return decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: r.data }) as string;
  } catch {
    try {
      const b = decodeFunctionResult({ abi: erc20Bytes32Abi, functionName: fn, data: r.data }) as Hex;
      return Buffer.from(b.slice(2), 'hex').toString('utf8').replace(/\0+$/g, '') || null;
    } catch {
      return null;
    }
  }
}

/** Fetch symbol/name/decimals for several tokens at a block. */
export async function fetchTokenMeta(
  rpc: RpcPool,
  chain: HistoryChain,
  block: number,
  tokens: string[],
  signal?: AbortSignal,
): Promise<Map<string, { symbol: string | null; name: string | null; decimals: number | null }>> {
  const calls: HistCall[] = [];
  for (const t of tokens) {
    calls.push(call(t, encodeFunctionData({ abi: erc20Abi, functionName: 'symbol' })));
    calls.push(call(t, encodeFunctionData({ abi: erc20Abi, functionName: 'name' })));
    calls.push(call(t, encodeFunctionData({ abi: erc20Abi, functionName: 'decimals' })));
  }
  const res = await multicallAt(rpc, chain, block, calls, signal);
  const out = new Map<string, { symbol: string | null; name: string | null; decimals: number | null }>();
  tokens.forEach((t, i) => {
    const d = res[i * 3 + 2];
    const decimals = d && d.success && d.data.length >= 66 ? Number(BigInt(d.data.slice(0, 66))) : null;
    out.set(t.toLowerCase(), {
      symbol: decodeStr(res[i * 3], 'symbol'),
      name: decodeStr(res[i * 3 + 1], 'name'),
      decimals: decimals != null && decimals <= 255 ? decimals : null,
    });
  });
  return out;
}

/**
 * Per-chain cache of reserve -> position tokens, seeded from the tokens table and extended when a
 * reserve list at some block contains assets we have not seen yet.
 */
export class ReserveCache {
  /** market key -> asset -> tokens */
  private byMarket = new Map<string, Map<string, ReserveTokens>>();

  constructor(
    private db: Db,
    public chain: HistoryChain,
    private rpc: RpcPool,
    private log: HistoryLogger,
  ) {
    for (const m of marketsForChain(chain)) this.byMarket.set(m.key, new Map());
    this.seedFromDb();
  }

  private seedFromDb(): void {
    const rows = histListAaveTokens(this.db, this.chain);
    const tmp = new Map<string, Partial<ReserveTokens> & { market: string; asset: string }>();
    for (const r of rows) {
      if (!r.underlying || !r.market || !this.byMarket.has(r.market)) continue;
      const k = `${r.market}|${r.underlying.toLowerCase()}`;
      const e = tmp.get(k) ?? { market: r.market, asset: r.underlying.toLowerCase() };
      if (r.kind === 'atoken') e.aToken = r.address.toLowerCase();
      if (r.kind === 'vdebt') e.vDebt = r.address.toLowerCase();
      if (r.kind === 'sdebt') e.sDebt = r.address.toLowerCase();
      if (r.decimals != null) e.decimals = r.decimals;
      if (r.price_key) e.priceKey = r.price_key;
      tmp.set(k, e);
    }
    for (const e of tmp.values()) {
      if (!e.aToken || !e.vDebt || e.decimals == null) continue;
      this.byMarket.get(e.market)!.set(e.asset, {
        market: e.market,
        asset: e.asset,
        aToken: e.aToken,
        vDebt: e.vDebt,
        sDebt: e.sDebt ?? null,
        decimals: e.decimals,
        symbol: '',
        priceKey: e.priceKey ?? canonicalPriceKey(this.chain, e.asset),
      });
    }
  }

  reserves(market: string): ReserveTokens[] {
    return [...(this.byMarket.get(market)?.values() ?? [])];
  }

  all(): ReserveTokens[] {
    return [...this.byMarket.values()].flatMap((m) => [...m.values()]);
  }

  /** True for any aToken / variable debt / stable debt token address of a known reserve. Such tokens
   *  must never be valued as wallet tokens as well (that would double count collateral and debt). */
  isPositionToken(address: string): boolean {
    const a = address.toLowerCase();
    for (const m of this.byMarket.values()) for (const r of m.values()) if (r.aToken === a || r.vDebt === a || r.sDebt === a) return true;
    return false;
  }

  has(market: string, asset: string): boolean {
    return this.byMarket.get(market)?.has(asset.toLowerCase()) ?? false;
  }

  /** Read getReservesList for every market of the chain at `block` and register unknown reserves. Returns number added. */
  async refreshAt(block: number, signal?: AbortSignal): Promise<number> {
    const markets = marketsForChain(this.chain);
    const lists = await multicallAt(
      this.rpc,
      this.chain,
      block,
      markets.map((m) => call(m.pool, encReservesList())),
      signal,
    );
    const missing: { market: HistAaveMarket; asset: string }[] = [];
    markets.forEach((m, i) => {
      for (const a of decodeReservesList(lists[i]) ?? []) if (!this.has(m.key, a)) missing.push({ market: m, asset: a });
    });
    if (missing.length) await this.addReserves(missing, block, signal);
    return missing.length;
  }

  /** Register reserves (getReserveData + underlying metadata at `block`). */
  async addReserves(items: { market: HistAaveMarket; asset: string }[], block: number, signal?: AbortSignal): Promise<void> {
    const rd = await multicallAt(
      this.rpc,
      this.chain,
      block,
      items.map((x) => call(x.market.pool, encodeFunctionData({ abi: poolAbi, functionName: 'getReserveData', args: [x.asset as Hex] }))),
      signal,
    );
    const meta = await fetchTokenMeta(
      this.rpc,
      this.chain,
      block,
      items.map((x) => x.asset),
      signal,
    );
    items.forEach((x, i) => {
      const r = rd[i];
      if (!r || !r.success || r.data.length < 66) {
        this.log.warn(`aave ${x.market.key}: getReserveData failed for ${x.asset} at ${block}`);
        return;
      }
      let decoded: { aTokenAddress: string; stableDebtTokenAddress: string; variableDebtTokenAddress: string };
      try {
        decoded = decodeFunctionResult({ abi: poolAbi, functionName: 'getReserveData', data: r.data }) as typeof decoded;
      } catch {
        this.log.warn(`aave ${x.market.key}: getReserveData undecodable for ${x.asset}`);
        return;
      }
      const m = meta.get(x.asset) ?? { symbol: null, name: null, decimals: null };
      if (m.decimals == null) {
        this.log.warn(`aave ${x.market.key}: no decimals for underlying ${x.asset}`);
        return;
      }
      const symbol = m.symbol ?? '?';
      const priceKey = canonicalPriceKey(this.chain, x.asset, { symbol, trusted: true });
      const rt: ReserveTokens = {
        market: x.market.key,
        asset: x.asset,
        aToken: decoded.aTokenAddress.toLowerCase(),
        vDebt: decoded.variableDebtTokenAddress.toLowerCase(),
        sDebt: decoded.stableDebtTokenAddress.toLowerCase() === ZERO ? null : decoded.stableDebtTokenAddress.toLowerCase(),
        decimals: m.decimals,
        symbol,
        priceKey,
      };
      this.byMarket.get(x.market.key)!.set(x.asset, rt);
      const base: Omit<HistTokenRow, 'address' | 'kind' | 'symbol' | 'name'> = {
        chain: this.chain,
        decimals: m.decimals,
        underlying: x.asset,
        market: x.market.key,
        price_key: priceKey,
        spam: 0,
      };
      histInsertTokenIfMissing(this.db, { ...base, address: x.asset, kind: 'erc20', symbol, name: m.name, market: null, underlying: null });
      histUpsertAaveToken(this.db, { ...base, address: rt.aToken, kind: 'atoken', symbol: `a${symbol}`, name: `Aave ${symbol}` });
      histUpsertAaveToken(this.db, { ...base, address: rt.vDebt, kind: 'vdebt', symbol: `variableDebt${symbol}`, name: `Aave variable debt ${symbol}` });
      if (rt.sDebt) histUpsertAaveToken(this.db, { ...base, address: rt.sDebt, kind: 'sdebt', symbol: `stableDebt${symbol}`, name: `Aave stable debt ${symbol}` });
    });
  }
}

export { ZERO as ZERO_ADDRESS };
