// Generate a fully SYNTHETIC demo database: no RPC key, no network access, no real wallets.
//
//   npm run demo:data                                   # writes ./data/demo.db
//   DATABASE_PATH=./data/other.db npm run demo:data     # another file
//   npm run demo:data -- --force                        # replace an existing demo database
//
// Then run the UI against it:  DATABASE_PATH=./data/demo.db npm run dev
// (do not start the worker on it: it would try to scan the made-up addresses on chain).
//
// Contents: two wallets ("Main", "Cold storage"), three made-up addresses, ~2 years of daily history,
// 7 days of hourly points, 24 hours of 15 minute live snapshots and:
// - a leveraged Aave v3 position on Arbitrum (WETH + WBTC supplied, USDC borrowed, levered up twice
//   to a health factor around 1.7) whose balances grow with daily moving supply / borrow rates and
//   reserve indices (aave_rates), so interest earned / paid and the rate history have real movement;
// - a Curve crvUSD loan (WETH collateral) held by the same Safe on Ethereum;
// - ETH / BTC / USDC holdings, daily / hourly / live prices from seeded random curves;
// - daily USD/EUR and USD/CHF rates;
// - a ledger with deposits from exchanges, internal transfers, Aave supply / borrow / leverage boosts,
//   the Curve loan, an Ethereum -> Arbitrum bridge pair, swaps, a send, gas fees and a spam airdrop;
// - one pending smart wallet suggestion (a Safe owned by the hot wallet).
// Everything goes through the normal migrations and repository functions, so every API route works on
// it. The output is deterministic for a given day (seeded PRNG).
//
// .env is deliberately NOT loaded: a DATABASE_PATH there usually points at the real database.
import fs from 'node:fs';
import path from 'node:path';
import {
  histInsertDailyPrices,
  histInsertFx,
  histInsertHourlyPrices,
  histSetProgress,
  histSetStart,
  histUpsertAaveToken,
  histWriteDailyChainDay,
  histWriteHourlyChainHour,
  type HistAddressDay,
} from '../lib/db/repos-history';
import {
  NATIVE,
  scanAddAddressToken,
  scanEnsureAddress,
  scanEnsureNativeToken,
  scanEnsureWallet,
  scanInsertLivePrices,
  scanInsertToken,
  scanLinkWalletAddress,
  scanSetIsContract,
  scanSetMeta,
  scanWriteLiveSlices,
  scanWriteReserveStates,
  type ScanAaveAccountRow,
  type ScanBalanceRow,
  type ScanChain,
  type ScanSlice,
} from '../lib/db/repos-scan';
import type { Db } from '../lib/history/types';
import { applyL1ToL2Alias, rebuildBridgePairs } from '../lib/ledger/bridge';
import {
  curveProtocolTotals,
  registerCurveMarket,
  valueCurvePosition,
  writeCurvePositions,
  type CurveMarket,
  type CurveValued,
} from '../lib/protocols/curve-crvusd';
import { upsertSuggestion } from '../lib/queries/suggestions';
import { migrateDb, openDb } from '../lib/scan/env';
import { createLogger } from '../lib/scan/log';

const HOUR = 3600;
const DAY = 86_400;
const YEAR = 365 * DAY;
const HISTORY_DAYS = 730;
const LIVE_STEP = 15 * 60;
const LIVE_POINTS = 96; // 24 hours
const HOURLY_HOURS = 168; // 7 days

// ---------- deterministic randomness ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** Stable pseudo-random value in [-1, 1] for an integer (used for intra-day noise). */
function hashNoise(n: number, salt: number): number {
  let x = Math.imul(n ^ (salt * 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

// ---------- synthetic addresses (not real wallets) ----------

const ADDR = {
  hot: '0xd3e0000000000000000000000000000000000001',
  vault: '0xd3e0000000000000000000000000000000000002',
  cold: '0xd3e0000000000000000000000000000000000003',
};
// made-up counterparties
const EXCHANGE = '0xd3e00000000000000000000000000000000000e1';
const FRIEND = '0xd3e00000000000000000000000000000000000e2';
const ROUTER = '0xd3e00000000000000000000000000000000000e3';
const SPAMMER = '0xd3e00000000000000000000000000000000000e4';
/** a made-up Safe owned by the hot wallet, offered as a smart wallet suggestion */
const SUGGESTED_SAFE = '0xd3e0000000000000000000000000000000000005';

// ---------- tokens and contracts (public addresses of the real assets / protocols) ----------

const KEY = {
  eth: 'coingecko:ethereum',
  btc: 'coingecko:wrapped-bitcoin',
  usdc: 'coingecko:usd-coin',
  crvusd: 'coingecko:crvusd',
} as const;
type PriceKey = (typeof KEY)[keyof typeof KEY];

const T = {
  eth: {
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    crvUSD: '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
  },
  arb: {
    WETH: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    WBTC: '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    aWETH: '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8',
    aWBTC: '0x078f358208685046a11c85e8ad32895ded33a249',
    aUSDC: '0x724dc807b04555b71ed48a6896b6f41593b8c637',
    vdUSDC: '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6',
    SPAM: '0xd3e00000000000000000000000000000000005a1',
  },
};
/** Arbitrum Delayed Inbox on Ethereum (ETH deposits to Arbitrum) */
const ARB_INBOX = '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f';

/** Curve crvUSD WETH mint market (public contracts of the ControllerFactory, market index 3) */
const CURVE_WETH: CurveMarket = {
  chain: 'ethereum',
  kind: 'mint',
  idx: 3,
  controller: '0xa920de414ea4ab66b97da1bfe9e6eca7d4219635',
  amm: '0x1681195c176239ac5e72d9aebacf5b2492e0c4ee',
  vault: null,
  collateral: T.eth.WETH,
  borrowed: T.eth.crvUSD,
  collateralSymbol: 'WETH',
  borrowedSymbol: 'crvUSD',
  collateralDecimals: 18,
  borrowedDecimals: 18,
  collateralKey: KEY.eth,
  borrowedKey: KEY.crvusd,
  market: 'eth-crvusd-3-weth',
  protocol: 'curve-crvusd',
};
const CURVE_RATE = 0.087; // crvUSD borrow APY of the demo loan

interface TokenInfo {
  decimals: number;
  key: PriceKey | null;
}

const TOKEN_INFO: Record<ScanChain, Record<string, TokenInfo>> = {
  ethereum: {
    [NATIVE]: { decimals: 18, key: KEY.eth },
    [T.eth.USDC]: { decimals: 6, key: KEY.usdc },
    [T.eth.WBTC]: { decimals: 8, key: KEY.btc },
    [T.eth.WETH]: { decimals: 18, key: KEY.eth },
    [T.eth.crvUSD]: { decimals: 18, key: KEY.crvusd },
  },
  arbitrum: {
    [NATIVE]: { decimals: 18, key: KEY.eth },
    [T.arb.WETH]: { decimals: 18, key: KEY.eth },
    [T.arb.WBTC]: { decimals: 8, key: KEY.btc },
    [T.arb.USDC]: { decimals: 6, key: KEY.usdc },
    [T.arb.aWETH]: { decimals: 18, key: KEY.eth },
    [T.arb.aWBTC]: { decimals: 8, key: KEY.btc },
    [T.arb.aUSDC]: { decimals: 6, key: KEY.usdc },
    [T.arb.vdUSDC]: { decimals: 6, key: KEY.usdc },
    [T.arb.SPAM]: { decimals: 18, key: null },
  },
};

const MARKET = 'arb-core';
// synthetic but realistic Aave v3 reserve parameters; APYs move daily (see Rates)
const RESERVES = [
  { asset: T.arb.WETH, aToken: T.arb.aWETH, reserveId: 4, borrowBase: 0.027, borrowAmp: 0.008, supplyShare: 0.55, ltvBps: 8000, ltBps: 8300 },
  { asset: T.arb.WBTC, aToken: T.arb.aWBTC, reserveId: 3, borrowBase: 0.0068, borrowAmp: 0.002, supplyShare: 0.12, ltvBps: 7300, ltBps: 7800 },
  { asset: T.arb.USDC, aToken: T.arb.aUSDC, reserveId: 12, borrowBase: 0.058, borrowAmp: 0.02, supplyShare: 0.72, ltvBps: 7500, ltBps: 7800 },
];
type ReserveIdx = 0 | 1 | 2;
const R_WETH: ReserveIdx = 0;
const R_WBTC: ReserveIdx = 1;
const R_USDC: ReserveIdx = 2;

function rawAmount(amount: number, decimals: number): string {
  // 6 significant decimals are plenty for a demo; scale the rest with BigInt to stay exact
  const micro = BigInt(Math.round(amount * 1e6));
  return decimals >= 6 ? (micro * 10n ** BigInt(decimals - 6)).toString() : (micro / 10n ** BigInt(6 - decimals)).toString();
}

// ---------- prices ----------

interface Curve {
  start: number;
  end: number;
  vol: number;
  seed: number;
}

const CURVES: Record<PriceKey, Curve> = {
  [KEY.eth]: { start: 2550, end: 3350, vol: 0.032, seed: 66 },
  [KEY.btc]: { start: 59_000, end: 94_000, vol: 0.022, seed: 139 },
  [KEY.usdc]: { start: 1, end: 1, vol: 0, seed: 37 },
  [KEY.crvusd]: { start: 1, end: 1, vol: 0, seed: 41 },
};

/** Daily log-price path: straight line between start and end + a Brownian bridge + slow waves. */
function buildDailyPath(c: Curve, days: number): number[] {
  const rnd = mulberry32(c.seed);
  const walk = [0];
  for (let i = 1; i <= days; i++) walk.push(walk[i - 1] + gaussian(rnd) * c.vol);
  const last = walk[days];
  const a = Math.log(c.start);
  const b = Math.log(c.end);
  const out: number[] = [];
  for (let i = 0; i <= days; i++) {
    const f = i / days;
    const bridge = walk[i] - f * last;
    const waves = c.vol ? 0.12 * Math.sin(f * Math.PI * 3.1) + 0.05 * Math.sin(f * Math.PI * 11.3) : 0;
    out.push(Math.exp(a + (b - a) * f + bridge + waves * Math.sin(f * Math.PI)));
  }
  return out;
}

class Prices {
  private paths = new Map<PriceKey, number[]>();
  constructor(
    private firstDay: number,
    private days: number,
  ) {
    for (const k of Object.keys(CURVES) as PriceKey[]) this.paths.set(k, buildDailyPath(CURVES[k], days + 1));
  }

  /** Price at any time: daily path interpolated, plus hour / 15 minute noise (stablecoins: tiny noise). */
  at(key: PriceKey, t: number): number {
    const p = this.paths.get(key)!;
    const x = Math.min(Math.max((t - this.firstDay) / DAY, 0), p.length - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, p.length - 1);
    const base = Math.exp(Math.log(p[i]) + (Math.log(p[j]) - Math.log(p[i])) * (x - i));
    const vol = CURVES[key].vol;
    if (!vol) return (key === KEY.crvusd ? 0.999 : 1) + 0.0004 * hashNoise(Math.floor(t / HOUR), CURVES[key].seed);
    const hourly = 0.004 * hashNoise(Math.floor(t / HOUR), CURVES[key].seed);
    const quarter = 0.0015 * hashNoise(Math.floor(t / LIVE_STEP), CURVES[key].seed + 1);
    return base * (1 + hourly + quarter);
  }

  daily(key: PriceKey, dayTs: number): number {
    return this.at(key, dayTs);
  }
}

// ---------- Aave rates and reserve indices ----------

/** Daily supply / borrow APY per reserve (slow waves + noise) and the cumulative liquidity / borrow indices. */
class Rates {
  readonly supply: number[][] = [];
  readonly borrow: number[][] = [];
  readonly liqIdx: number[][] = [];
  readonly borIdx: number[][] = [];
  constructor(
    readonly firstDay: number,
    readonly days: number,
  ) {
    const rnd = mulberry32(71);
    RESERVES.forEach((r, i) => {
      const s: number[] = [];
      const b: number[] = [];
      const li = [1];
      const bi = [1];
      let drift = 0;
      for (let d = 0; d <= days; d++) {
        const f = d / days;
        drift = drift * 0.9 + gaussian(rnd) * 0.12;
        const wave = Math.sin(f * Math.PI * 2 * (2.1 + i * 0.7) + i) * 0.7 + Math.sin(f * Math.PI * 2 * 9.3 + i * 2) * 0.3;
        const borrow = Math.max(r.borrowBase * 0.35, r.borrowBase + r.borrowAmp * (wave + drift));
        // utilisation moves with the borrow rate, so supply rates follow it more than linearly
        const supply = borrow * r.supplyShare * (0.85 + 0.15 * Math.tanh(wave + drift));
        b.push(borrow);
        s.push(supply);
        if (d > 0) {
          li.push(li[d - 1] * Math.pow(1 + s[d - 1], 1 / 365));
          bi.push(bi[d - 1] * Math.pow(1 + b[d - 1], 1 / 365));
        }
      }
      this.supply.push(s);
      this.borrow.push(b);
      this.liqIdx.push(li);
      this.borIdx.push(bi);
    });
  }

  private day(t: number): { d: number; frac: number } {
    const x = Math.min(Math.max((t - this.firstDay) / DAY, 0), this.days);
    const d = Math.min(Math.floor(x), this.days);
    return { d, frac: x - d };
  }

  /** Index at any time: last day's index compounded with that day's rate. */
  index(r: ReserveIdx, side: 'supply' | 'borrow', t: number): number {
    const { d, frac } = this.day(t);
    const idx = side === 'supply' ? this.liqIdx[r][d] : this.borIdx[r][d];
    const apy = side === 'supply' ? this.supply[r][d] : this.borrow[r][d];
    return idx * Math.pow(1 + apy, frac / 365);
  }

  apy(r: ReserveIdx, side: 'supply' | 'borrow', t: number): number {
    const { d } = this.day(t);
    return side === 'supply' ? this.supply[r][d] : this.borrow[r][d];
  }
}

// ---------- the story: events, ledger transactions and holdings over time ----------

interface Holding {
  token: string;
  amount: number;
  protocol: 'wallet' | 'aave-v3';
  side: 'wallet' | 'supply' | 'borrow';
}

type AddrKey = keyof typeof ADDR;

interface Leg {
  token: string;
  from: string;
  to: string;
  amount: number;
}

interface DemoTx {
  chain: ScanChain;
  ts: number;
  /** transaction sender (pays the fee) */
  from: string;
  feeEth?: number;
  legs: Leg[];
}

/** Aave position change: scaled balance = amount / index at the time (like the real aToken). */
interface AaveEvent {
  t: number;
  reserve: ReserveIdx;
  side: 'supply' | 'borrow';
  amount: number;
}

/** Event time `d` days before today at hh:00 UTC. */
function eventTs(today: number, d: number, hh = 14): number {
  return today - d * DAY + hh * HOUR;
}

class Story {
  readonly ev: Record<string, number>;
  readonly aave: AaveEvent[] = [];
  readonly txs: DemoTx[] = [];
  readonly loan: { t: number; collateral: number; debt: number; bought: number };
  readonly bridgeEth = 1.5;

  constructor(
    readonly today: number,
    private prices: Prices,
    private rates: Rates,
  ) {
    const e = (d: number, hh?: number) => eventTs(today, d, hh);
    this.ev = {
      coldWbtcIn: e(720, 9),
      hotEthIn: e(700, 15),
      hotUsdcIn: e(650, 11),
      hotToCold: e(600, 20),
      vaultFunded: e(545, 10),
      vaultSupply: e(540, 12),
      vaultBorrow: e(539, 16),
      vaultToHot: e(538, 18),
      loanEthIn: e(432, 9),
      loanFund: e(430, 13),
      loanOpen: e(430, 14),
      boost1: e(300, 15),
      hotSwap: e(200, 13),
      bridgeL1: e(150, 19),
      hotSend: e(100, 17),
      boost2: e(12, 16),
      spam: e(30, 4),
    };
    const ev = this.ev;
    const eth = (t: number) => prices.at(KEY.eth, t);

    // Aave: initial supply and borrow, then two leverage boosts (borrow USDC, buy WETH, supply it)
    this.aave.push({ t: ev.vaultSupply, reserve: R_WETH, side: 'supply', amount: 8 });
    this.aave.push({ t: ev.vaultSupply, reserve: R_WBTC, side: 'supply', amount: 0.25 });
    this.aave.push({ t: ev.vaultBorrow, reserve: R_USDC, side: 'borrow', amount: 9000 });
    const boost = (t: number, target: number) => {
      const { lt, debt } = this.aaveTotals(t);
      const wethLt = RESERVES[R_WETH].ltBps / 10_000;
      const usd = Math.max(0, (lt - target * debt) / (target - wethLt));
      const usdc = Math.round(usd / 100) * 100;
      const weth = usdc / eth(t);
      this.aave.push({ t, reserve: R_USDC, side: 'borrow', amount: usdc });
      this.aave.push({ t, reserve: R_WETH, side: 'supply', amount: weth });
      return { usdc, weth };
    };
    const b1 = boost(ev.boost1, 2.05);
    const b2 = boost(ev.boost2, 1.68);

    // Curve: the Safe wraps 14 ETH, borrows crvUSD, buys more WETH and posts it all as collateral
    const debt = 34_000;
    const bought = debt / eth(ev.loanOpen);
    this.loan = { t: ev.loanOpen, collateral: 14 + bought, debt, bought };

    const aaveLegs = (usdc: number, weth: number): Leg[] => [
      { token: T.arb.vdUSDC, from: NATIVE, to: ADDR.vault, amount: usdc },
      { token: T.arb.USDC, from: T.arb.aUSDC, to: ADDR.vault, amount: usdc },
      { token: T.arb.USDC, from: ADDR.vault, to: ROUTER, amount: usdc },
      { token: T.arb.WETH, from: ROUTER, to: ADDR.vault, amount: weth },
      { token: T.arb.WETH, from: ADDR.vault, to: T.arb.aWETH, amount: weth },
      { token: T.arb.aWETH, from: NATIVE, to: ADDR.vault, amount: weth },
    ];
    const ARB_FEE = 0.000045;
    this.txs.push(
      { chain: 'ethereum', ts: ev.coldWbtcIn, from: EXCHANGE, legs: [{ token: T.eth.WBTC, from: EXCHANGE, to: ADDR.cold, amount: 0.6 }] },
      { chain: 'ethereum', ts: ev.hotEthIn, from: EXCHANGE, legs: [{ token: NATIVE, from: EXCHANGE, to: ADDR.hot, amount: 8 }] },
      { chain: 'ethereum', ts: ev.hotUsdcIn, from: FRIEND, legs: [{ token: T.eth.USDC, from: FRIEND, to: ADDR.hot, amount: 2500 }] },
      { chain: 'ethereum', ts: ev.hotToCold, from: ADDR.hot, feeEth: 0.0011, legs: [{ token: NATIVE, from: ADDR.hot, to: ADDR.cold, amount: 4 }] },
      {
        chain: 'ethereum',
        ts: ev.hotSwap,
        from: ADDR.hot,
        feeEth: 0.0016,
        legs: [
          { token: T.eth.USDC, from: ADDR.hot, to: ROUTER, amount: 500 },
          { token: NATIVE, from: ROUTER, to: ADDR.hot, amount: 0.155 },
        ],
      },
      { chain: 'ethereum', ts: ev.hotSend, from: ADDR.hot, feeEth: 0.0006, legs: [{ token: NATIVE, from: ADDR.hot, to: FRIEND, amount: 0.3 }] },
      { chain: 'ethereum', ts: ev.loanEthIn, from: EXCHANGE, legs: [{ token: NATIVE, from: EXCHANGE, to: ADDR.hot, amount: 14 }] },
      { chain: 'ethereum', ts: ev.loanFund, from: ADDR.hot, feeEth: 0.0009, legs: [{ token: NATIVE, from: ADDR.hot, to: ADDR.vault, amount: 14 }] },
      {
        chain: 'ethereum',
        ts: ev.loanOpen,
        from: ADDR.hot,
        feeEth: 0.0042,
        legs: [
          { token: NATIVE, from: ADDR.vault, to: T.eth.WETH, amount: 14 },
          { token: T.eth.WETH, from: NATIVE, to: ADDR.vault, amount: 14 },
          { token: T.eth.crvUSD, from: CURVE_WETH.controller, to: ADDR.vault, amount: debt },
          { token: T.eth.crvUSD, from: ADDR.vault, to: ROUTER, amount: debt },
          { token: T.eth.WETH, from: ROUTER, to: ADDR.vault, amount: bought },
          { token: T.eth.WETH, from: ADDR.vault, to: CURVE_WETH.amm, amount: 14 + bought },
        ],
      },
      { chain: 'ethereum', ts: ev.bridgeL1, from: ADDR.hot, feeEth: 0.0008, legs: [{ token: NATIVE, from: ADDR.hot, to: ARB_INBOX, amount: this.bridgeEth }] },
      {
        chain: 'arbitrum',
        ts: ev.vaultFunded,
        from: EXCHANGE,
        legs: [
          { token: T.arb.WETH, from: EXCHANGE, to: ADDR.vault, amount: 8 },
          { token: T.arb.WBTC, from: EXCHANGE, to: ADDR.vault, amount: 0.25 },
          { token: NATIVE, from: EXCHANGE, to: ADDR.vault, amount: 0.02 },
        ],
      },
      {
        chain: 'arbitrum',
        ts: ev.vaultSupply,
        from: ADDR.hot,
        feeEth: ARB_FEE,
        legs: [
          { token: T.arb.WETH, from: ADDR.vault, to: T.arb.aWETH, amount: 8 },
          { token: T.arb.aWETH, from: NATIVE, to: ADDR.vault, amount: 8 },
          { token: T.arb.WBTC, from: ADDR.vault, to: T.arb.aWBTC, amount: 0.25 },
          { token: T.arb.aWBTC, from: NATIVE, to: ADDR.vault, amount: 0.25 },
        ],
      },
      {
        chain: 'arbitrum',
        ts: ev.vaultBorrow,
        from: ADDR.hot,
        feeEth: ARB_FEE,
        legs: [
          { token: T.arb.vdUSDC, from: NATIVE, to: ADDR.vault, amount: 9000 },
          { token: T.arb.USDC, from: T.arb.aUSDC, to: ADDR.vault, amount: 9000 },
        ],
      },
      { chain: 'arbitrum', ts: ev.vaultToHot, from: ADDR.hot, feeEth: ARB_FEE, legs: [{ token: T.arb.USDC, from: ADDR.vault, to: ADDR.hot, amount: 9000 }] },
      { chain: 'arbitrum', ts: ev.vaultToHot + 60, from: ADDR.hot, feeEth: ARB_FEE, legs: [{ token: NATIVE, from: ADDR.vault, to: ADDR.hot, amount: 0.012 }] },
      { chain: 'arbitrum', ts: ev.boost1, from: ADDR.hot, feeEth: ARB_FEE * 3, legs: aaveLegs(b1.usdc, b1.weth) },
      {
        chain: 'arbitrum',
        ts: ev.bridgeL1 + 13 * 60,
        from: applyL1ToL2Alias(ADDR.hot),
        legs: [{ token: NATIVE, from: applyL1ToL2Alias(ADDR.hot), to: ADDR.hot, amount: this.bridgeEth }],
      },
      { chain: 'arbitrum', ts: ev.boost2, from: ADDR.hot, feeEth: ARB_FEE * 3, legs: aaveLegs(b2.usdc, b2.weth) },
      { chain: 'arbitrum', ts: ev.spam, from: SPAMMER, legs: [{ token: T.arb.SPAM, from: SPAMMER, to: ADDR.hot, amount: 1250 }] },
    );
  }

  /** Gas paid in ETH by `addr` on `chain` up to `t`. */
  private gas(addr: string, chain: ScanChain, t: number): number {
    let s = 0;
    for (const x of this.txs) if (x.chain === chain && x.from === addr && x.ts <= t) s += x.feeEth ?? 0;
    return s;
  }

  /** Aave token balances of the vault at `t` (underlying units). */
  aaveBalances(t: number): { reserve: ReserveIdx; side: 'supply' | 'borrow'; amount: number }[] {
    const scaled = new Map<string, { reserve: ReserveIdx; side: 'supply' | 'borrow'; s: number }>();
    for (const e of this.aave) {
      if (e.t > t) continue;
      const k = `${e.reserve}:${e.side}`;
      const cur = scaled.get(k) ?? { reserve: e.reserve, side: e.side, s: 0 };
      cur.s += e.amount / this.rates.index(e.reserve, e.side, e.t);
      scaled.set(k, cur);
    }
    return [...scaled.values()].map((v) => ({ reserve: v.reserve, side: v.side, amount: v.s * this.rates.index(v.reserve, v.side, t) }));
  }

  /** Liquidation-threshold weighted collateral and debt in USD at `t`. */
  private aaveTotals(t: number): { lt: number; debt: number } {
    let lt = 0;
    let debt = 0;
    for (const b of this.aaveBalances(t)) {
      const r = RESERVES[b.reserve];
      const usd = b.amount * this.prices.at(TOKEN_INFO.arbitrum[r.asset].key!, t);
      if (b.side === 'supply') lt += (usd * r.ltBps) / 10_000;
      else debt += usd;
    }
    return { lt, debt };
  }

  /** Curve loan state at `t`, null before the loan. */
  curveLoan(t: number): { collateral: number; debt: number } | null {
    if (t < this.loan.t) return null;
    const y = (t - this.loan.t) / YEAR;
    return { collateral: this.loan.collateral, debt: this.loan.debt * Math.exp(CURVE_RATE * y) };
  }

  holdings(who: AddrKey, chain: ScanChain, t: number): Holding[] {
    const ev = this.ev;
    const out: Holding[] = [];
    const w = (token: string, amount: number) => amount > 1e-9 && out.push({ token, amount, protocol: 'wallet', side: 'wallet' });
    if (who === 'hot' && chain === 'ethereum') {
      let eth = 0;
      if (t >= ev.hotEthIn) eth += 8;
      if (t >= ev.hotToCold) eth -= 4;
      if (t >= ev.loanEthIn) eth += 14;
      if (t >= ev.loanFund) eth -= 14;
      if (t >= ev.hotSwap) eth += 0.155;
      if (t >= ev.bridgeL1) eth -= this.bridgeEth;
      if (t >= ev.hotSend) eth -= 0.3;
      w(NATIVE, eth - this.gas(ADDR.hot, 'ethereum', t));
      let usdc = 0;
      if (t >= ev.hotUsdcIn) usdc += 2500;
      if (t >= ev.hotSwap) usdc -= 500;
      w(T.eth.USDC, usdc);
    }
    if (who === 'hot' && chain === 'arbitrum') {
      if (t >= ev.vaultToHot) w(T.arb.USDC, 9000);
      let eth = 0;
      if (t >= ev.vaultToHot + 60) eth += 0.012;
      if (t >= ev.bridgeL1 + 13 * 60) eth += this.bridgeEth;
      w(NATIVE, eth - this.gas(ADDR.hot, 'arbitrum', t));
      if (t >= ev.spam) out.push({ token: T.arb.SPAM, amount: 1250, protocol: 'wallet', side: 'wallet' });
    }
    if (who === 'cold' && chain === 'ethereum') {
      if (t >= ev.coldWbtcIn) w(T.eth.WBTC, 0.6);
      if (t >= ev.hotToCold) w(NATIVE, 4);
    }
    if (who === 'vault' && chain === 'ethereum') {
      if (t >= ev.loanFund && t < ev.loanOpen) w(NATIVE, 14);
    }
    if (who === 'vault' && chain === 'arbitrum') {
      if (t >= ev.vaultFunded && t < ev.vaultSupply) {
        w(T.arb.WETH, 8);
        w(T.arb.WBTC, 0.25);
      }
      if (t >= ev.vaultFunded) w(NATIVE, t >= ev.vaultToHot + 60 ? 0.008 : 0.02);
      for (const b of this.aaveBalances(t)) {
        const r = RESERVES[b.reserve];
        if (b.side === 'supply') out.push({ token: r.aToken, amount: b.amount, protocol: 'aave-v3', side: 'supply' });
        else out.push({ token: T.arb.vdUSDC, amount: b.amount, protocol: 'aave-v3', side: 'borrow' });
      }
      if (t >= ev.vaultBorrow && t < ev.vaultToHot) w(T.arb.USDC, 9000);
    }
    return out;
  }

  /** First activity per (address, chain), used as the backfill start. */
  start(who: AddrKey, chain: ScanChain): number | null {
    const ev = this.ev;
    const m: Record<string, number> = {
      'hot|ethereum': ev.hotEthIn,
      'hot|arbitrum': ev.vaultToHot,
      'cold|ethereum': ev.coldWbtcIn,
      'vault|arbitrum': ev.vaultFunded,
      'vault|ethereum': ev.loanFund,
    };
    return m[`${who}|${chain}`] ?? null;
  }
}

const CHAINS_OF: Record<AddrKey, ScanChain[]> = { hot: ['ethereum', 'arbitrum'], vault: ['arbitrum', 'ethereum'], cold: ['ethereum'] };

interface Valued {
  balances: ScanBalanceRow[];
  positions: { protocol: string; usd: number }[];
  aave: ScanAaveAccountRow[];
  /** Curve loan of this slice, if any */
  curve: CurveValued | null;
}

function value(
  story: Story,
  who: AddrKey,
  chain: ScanChain,
  t: number,
  price: (k: PriceKey) => number,
  withRisk: boolean,
): Valued {
  const holdings = story.holdings(who, chain, t);
  const balances: ScanBalanceRow[] = [];
  let wallet = 0;
  let aave = 0;
  let aaveAny = false;
  let collateral = 0;
  let collateralLt = 0;
  let collateralLtv = 0;
  let debt = 0;
  for (const h of holdings) {
    const info = TOKEN_INFO[chain][h.token];
    const px = info.key ? price(info.key) : 0; // the spam token has no price
    const usd = (h.side === 'borrow' ? -1 : 1) * h.amount * px;
    balances.push({ token: h.token, amountRaw: rawAmount(h.amount, info.decimals), amount: h.amount, usd, protocol: h.protocol, side: h.side });
    if (h.protocol === 'wallet') wallet += usd;
    else {
      aave += usd;
      aaveAny = true;
      if (h.side === 'supply') {
        const r = RESERVES.find((x) => TOKEN_INFO.arbitrum[x.asset].key === info.key)!;
        collateral += usd;
        collateralLt += usd * r.ltBps;
        collateralLtv += usd * r.ltvBps;
      } else debt += -usd;
    }
  }
  const positions = [{ protocol: 'wallet', usd: wallet }];
  if (aaveAny) positions.push({ protocol: 'aave-v3', usd: aave });
  const accounts: ScanAaveAccountRow[] = [];
  if (aaveAny) {
    const ltBps = collateral ? Math.round(collateralLt / collateral) : 0;
    const ltvBps = collateral ? Math.round(collateralLtv / collateral) : 0;
    const acct: ScanAaveAccountRow = {
      market: MARKET,
      collateralUsd: collateral,
      debtUsd: debt,
      healthFactor: debt > 0 ? (collateral * ltBps) / 10_000 / debt : null,
    };
    if (withRisk) {
      // collateral bit 2*id+1 for WETH and WBTC, borrowing bit 2*id for USDC
      const cfg = (1n << BigInt(2 * 4 + 1)) | (1n << BigInt(2 * 3 + 1)) | (debt > 0 ? 1n << BigInt(2 * 12) : 0n);
      Object.assign(acct, { emode: 0, emodeLtvBps: null, emodeLtBps: null, emodeBitmap: null, userConfig: cfg.toString(), ltvBps, ltBps });
    }
    accounts.push(acct);
  }
  // Curve crvUSD loan of the Safe on Ethereum: AMM / Controller pseudo token rows, one position value
  let curve: CurveValued | null = null;
  const loan = who === 'vault' && chain === 'ethereum' ? story.curveLoan(t) : null;
  if (loan) {
    const pc = price(KEY.eth);
    const pb = price(KEY.crvusd);
    // Curve health: collateral value after the market's loan discount over the debt, minus 1
    const health = (loan.collateral * pc * 0.93) / (loan.debt * pb) - 1;
    curve = valueCurvePosition(
      CURVE_WETH,
      {
        collateralRaw: BigInt(rawAmount(loan.collateral, 18)),
        stableRaw: 0n,
        debtRaw: BigInt(rawAmount(loan.debt, 18)),
        healthRaw: BigInt(Math.round(health * 1e6)) * 10n ** 12n,
      },
      pc,
      pb,
    );
    if (curve) {
      balances.push(...curve.rows);
      positions.push(...curveProtocolTotals([curve]));
    }
  }
  return { balances, positions, aave: accounts, curve };
}

// ---------- ledger ----------

const blockAt = (chain: ScanChain, ts: number) => (chain === 'ethereum' ? Math.floor((ts - 1_438_269_973) / 12) : Math.floor((ts - 1_622_243_344) * 4));

function writeLedger(db: Db, story: Story, ids: Record<AddrKey, number>, prices: Prices): number {
  const txs = story.txs;
  const own = new Map<string, number>((Object.keys(ADDR) as AddrKey[]).map((k) => [ADDR[k], ids[k]]));
  const insTx = db.prepare('INSERT OR REPLACE INTO tx (chain, hash, block, ts, from_addr, receipt, fee_wei, fee_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insTr = db.prepare(
    `INSERT OR REPLACE INTO tx_transfers (chain, hash, ref, token, from_addr, to_addr, amount_raw, amount, usd, kind_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAddr = db.prepare('INSERT OR IGNORE INTO tx_addresses (address_id, chain, hash, ts) VALUES (?, ?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);
  // eth_getCode cache: exchanges and friends are EOAs (their transfers are deposits / withdrawals),
  // routers and protocol contracts are contracts (protocol interactions)
  const insCode = db.prepare('INSERT OR REPLACE INTO address_code (chain, address, is_contract, checked_at) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const c of ['ethereum', 'arbitrum'] as ScanChain[]) {
      for (const a of [EXCHANGE, FRIEND, SPAMMER]) insCode.run(c, a, 0, now);
      for (const a of [ROUTER, ...Object.values(ADDR).filter((a) => a !== ADDR.hot && a !== ADDR.cold)]) insCode.run(c, a, 1, now);
    }
    for (const a of [CURVE_WETH.controller, CURVE_WETH.amm, ARB_INBOX, T.eth.WETH]) insCode.run('ethereum', a, 1, now);
    txs.forEach((t, i) => {
      const hash = `0x${'de70'}${(i + 1).toString(16).padStart(60, '0')}`;
      const day = Math.floor(t.ts / DAY) * DAY;
      const ethPx = prices.daily(KEY.eth, day);
      const feeUsd = t.feeEth ? t.feeEth * ethPx : null;
      const feeWei = t.feeEth ? rawAmount(t.feeEth, 18) : null;
      insTx.run(t.chain, hash, blockAt(t.chain, t.ts), t.ts, t.from, t.feeEth ? 1 : 0, feeWei, feeUsd);
      t.legs.forEach((l, j) => {
        const info = TOKEN_INFO[t.chain][l.token];
        const usd = info.key ? l.amount * prices.daily(info.key, day) : null;
        insTr.run(t.chain, hash, `log:${j}`, l.token, l.from, l.to, rawAmount(l.amount, info.decimals), l.amount, usd, l.token === NATIVE ? 'native' : 'erc20');
        for (const a of [l.from, l.to]) {
          const id = own.get(a);
          if (id != null) insAddr.run(id, t.chain, hash, t.ts);
        }
      });
    });
    const st = db.prepare(
      `INSERT OR REPLACE INTO ledger_state (address_id, chain, last_block, native_block, updated_at, error) VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const k of Object.keys(ADDR) as AddrKey[]) {
      for (const c of CHAINS_OF[k]) st.run(ids[k], c, blockAt(c, now), blockAt(c, now), now);
    }
  })();
  rebuildBridgePairs(db, new Set(Object.values(ADDR)));
  return txs.length;
}

/** Daily Aave rates and reserve indices (aave_rates) for every day the vault holds a reserve. */
function writeAaveRates(db: Db, story: Story, rates: Rates, firstDay: number, today: number): number {
  const ins = db.prepare(
    `INSERT OR REPLACE INTO aave_rates (chain, market, asset, ts, block, supply_apy, borrow_apy, liquidity_index, borrow_index)
     VALUES ('arbitrum', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  const from = Math.floor(story.ev.vaultSupply / DAY) * DAY;
  db.transaction(() => {
    for (let d = Math.max(firstDay, from); d <= today; d += DAY) {
      RESERVES.forEach((r, i) => {
        const ri = i as ReserveIdx;
        ins.run(MARKET, r.asset, d, blockAt('arbitrum', d), rates.apy(ri, 'supply', d), rates.apy(ri, 'borrow', d), rates.index(ri, 'supply', d), rates.index(ri, 'borrow', d));
        n++;
      });
    }
  })();
  return n;
}

/** Daily FX for EUR and CHF (every calendar day, weekends carry the Friday rate like the real sync). */
function writeFx(db: Db, firstDay: number, today: number): void {
  const rnd = mulberry32(53);
  let chf = 0.905;
  let eur = 0.925;
  const chfRows: { day: string; usdChf: number }[] = [];
  const eurRows: [string, number][] = [];
  for (let d = firstDay; d <= today; d += DAY) {
    const wd = new Date(d * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const common = gaussian(rnd) * 0.0028;
      chf = Math.min(0.95, Math.max(0.78, chf * (1 + common + gaussian(rnd) * 0.0018) - (chf - 0.86) * 0.002));
      eur = Math.min(0.98, Math.max(0.84, eur * (1 + common + gaussian(rnd) * 0.0016) - (eur - 0.91) * 0.002));
    }
    const day = new Date(d * 1000).toISOString().slice(0, 10);
    chfRows.push({ day, usdChf: Math.round(chf * 1e5) / 1e5 });
    eurRows.push([day, Math.round(eur * 1e5) / 1e5]);
  }
  histInsertFx(db, chfRows);
  const ins = db.prepare("INSERT OR REPLACE INTO fx (day, currency, rate_from_usd) VALUES (?, 'EUR', ?)");
  db.transaction(() => {
    for (const [day, r] of eurRows) ins.run(day, r);
  })();
}

// ---------- main ----------

function hasRows(db: Db, table: string): boolean {
  try {
    return !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  } catch {
    return false;
  }
}

function rel(file: string): string {
  const r = path.relative(process.cwd(), file);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? `./${r}` : file;
}

async function main(): Promise<void> {
  const log = createLogger('demo', { json: false });
  const file = path.resolve(process.cwd(), process.env.DATABASE_PATH || './data/demo.db');
  const force = process.argv.includes('--force');
  if (fs.existsSync(file)) {
    const probe = openDb(file);
    const used = hasRows(probe, 'wallets') || hasRows(probe, 'snapshots');
    let isDemo = false;
    try {
      isDemo = !!probe.prepare("SELECT 1 FROM meta WHERE key = 'demo_data'").get();
    } catch {
      /* no meta table: not a demo database */
    }
    probe.close();
    if (used && !isDemo) {
      console.error(`${file} contains data that was not generated by this script. Refusing to touch it; choose another DATABASE_PATH.`);
      process.exit(2);
    }
    if (used && !force) {
      console.error(`${file} already contains data. Re-run with --force to replace it (the file is deleted first).`);
      process.exit(2);
    }
    if (used) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }

  const db = openDb(file);
  await migrateDb(db, log);
  log.info(`writing synthetic demo data to ${file}`);

  const nowTs = Math.floor(Date.now() / 1000);
  const today = Math.floor(nowTs / DAY) * DAY;
  const firstDay = today - HISTORY_DAYS * DAY;
  const prices = new Prices(firstDay, HISTORY_DAYS + 2);
  const rates = new Rates(firstDay, HISTORY_DAYS + 2);
  const story = new Story(today, prices, rates);

  // wallets and addresses
  const main = scanEnsureWallet(db, 'Main', '#ea5a1f');
  const cold = scanEnsureWallet(db, 'Cold storage', '#3b82f6');
  const ids: Record<AddrKey, number> = {
    hot: scanEnsureAddress(db, ADDR.hot, 'Hot wallet', CHAINS_OF.hot).id,
    vault: scanEnsureAddress(db, ADDR.vault, 'Aave vault', CHAINS_OF.vault).id,
    cold: scanEnsureAddress(db, ADDR.cold, 'Hardware wallet', CHAINS_OF.cold).id,
  };
  scanLinkWalletAddress(db, main, ids.hot);
  scanLinkWalletAddress(db, main, ids.vault);
  scanLinkWalletAddress(db, cold, ids.cold);
  for (const k of Object.keys(ids) as AddrKey[]) for (const c of CHAINS_OF[k]) scanSetIsContract(db, ids[k], c, k === 'vault');

  // tokens
  for (const c of ['ethereum', 'arbitrum'] as ScanChain[]) scanEnsureNativeToken(db, c);
  const erc20 = (chain: ScanChain, address: string, symbol: string, name: string, decimals: number, key: string | null, spam = 0) =>
    scanInsertToken(db, { chain, address, symbol, name, decimals, kind: 'erc20', underlying: null, market: null, price_key: key, logo: null, spam });
  erc20('ethereum', T.eth.USDC, 'USDC', 'USD Coin', 6, KEY.usdc);
  erc20('ethereum', T.eth.WBTC, 'WBTC', 'Wrapped BTC', 8, KEY.btc);
  erc20('ethereum', T.eth.WETH, 'WETH', 'Wrapped Ether', 18, KEY.eth);
  erc20('arbitrum', T.arb.WETH, 'WETH', 'Wrapped Ether', 18, KEY.eth);
  erc20('arbitrum', T.arb.WBTC, 'WBTC', 'Wrapped BTC', 8, KEY.btc);
  erc20('arbitrum', T.arb.USDC, 'USDC', 'USD Coin', 6, KEY.usdc);
  erc20('arbitrum', T.arb.SPAM, 'CLAIM', 'Visit claim-rewards.example to claim', 18, null, 1);
  const aave = (address: string, symbol: string, name: string, decimals: number, kind: string, underlying: string, key: string) =>
    histUpsertAaveToken(db, { chain: 'arbitrum', address, symbol, name, decimals, kind, underlying, market: MARKET, price_key: key, spam: 0 });
  aave(T.arb.aWETH, 'aArbWETH', 'Aave Arbitrum WETH', 18, 'atoken', T.arb.WETH, KEY.eth);
  aave(T.arb.aWBTC, 'aArbWBTC', 'Aave Arbitrum WBTC', 8, 'atoken', T.arb.WBTC, KEY.btc);
  aave(T.arb.aUSDC, 'aArbUSDCn', 'Aave Arbitrum USDCn', 6, 'atoken', T.arb.USDC, KEY.usdc);
  aave(T.arb.vdUSDC, 'variableDebtArbUSDCn', 'Aave Arbitrum Variable Debt USDCn', 6, 'vdebt', T.arb.USDC, KEY.usdc);
  registerCurveMarket(db, CURVE_WETH);
  const held: Record<AddrKey, Partial<Record<ScanChain, string[]>>> = {
    hot: { ethereum: [NATIVE, T.eth.USDC], arbitrum: [NATIVE, T.arb.USDC, T.arb.SPAM] },
    vault: { arbitrum: [NATIVE, T.arb.WETH, T.arb.WBTC, T.arb.USDC], ethereum: [NATIVE, T.eth.WETH, T.eth.crvUSD] },
    cold: { ethereum: [NATIVE, T.eth.WBTC] },
  };
  for (const k of Object.keys(held) as AddrKey[]) {
    for (const [c, list] of Object.entries(held[k]) as [ScanChain, string[]][]) for (const t of list) scanAddAddressToken(db, ids[k], c, t, null);
  }
  // the Safe's loan was found through the controller's UserState logs (lib/protocols/curve-crvusd.ts)
  scanSetMeta(
    db,
    `history:curve:${ids.vault}:ethereum`,
    JSON.stringify({ lastBlock: blockAt('ethereum', nowTs), pairs: { [CURVE_WETH.controller]: blockAt('ethereum', story.loan.t) } }),
  );

  // prices, FX and Aave rates
  const keys = Object.values(KEY);
  const daily: { key: string; ts: number; usd: number }[] = [];
  for (let d = firstDay; d <= today; d += DAY) for (const k of keys) daily.push({ key: k, ts: d, usd: prices.daily(k, d) });
  histInsertDailyPrices(db, daily);
  const curHour = Math.floor(nowTs / HOUR) * HOUR;
  const hourly: { key: string; ts: number; usd: number }[] = [];
  for (let h = curHour - (HOURLY_HOURS + 24) * HOUR; h < curHour; h += HOUR) for (const k of keys) hourly.push({ key: k, ts: h, usd: prices.at(k, h) });
  histInsertHourlyPrices(db, hourly);
  writeFx(db, firstDay, today);
  const rateRows = writeAaveRates(db, story, rates, firstDay, today);

  const snapshotId = db.prepare('SELECT id FROM snapshots WHERE kind = ? AND ts = ?');
  const curveRows = (chain: ScanChain, snap: number, vals: { addressId: number; v: Valued }[], withApy: boolean) => {
    if (chain !== 'ethereum') return;
    const list = vals.filter((x) => x.v.curve).map((x) => ({ addressId: x.addressId, valued: x.v.curve!, borrowApy: withApy ? CURVE_RATE : null }));
    writeCurvePositions(db, snap, chain, vals.map((x) => x.addressId), list);
  };

  // daily history: every completed day from each slice's first activity
  let dailySlices = 0;
  let minHf = Infinity;
  for (let d = firstDay; d < today; d += DAY) {
    const endOfDay = d + DAY - 1;
    for (const chain of ['ethereum', 'arbitrum'] as ScanChain[]) {
      const entries: HistAddressDay[] = [];
      const vals: { addressId: number; v: Valued }[] = [];
      for (const k of Object.keys(ids) as AddrKey[]) {
        const start = story.start(k, chain);
        if (start == null || endOfDay < Math.floor(start / DAY) * DAY) continue;
        const v = value(story, k, chain, endOfDay, (key) => prices.daily(key, d), false);
        for (const a of v.aave) if (a.healthFactor != null) minHf = Math.min(minHf, a.healthFactor);
        entries.push({ addressId: ids[k], balances: v.balances, positions: v.positions, aave: v.aave });
        vals.push({ addressId: ids[k], v });
      }
      if (entries.length) {
        histWriteDailyChainDay(db, chain, d, chain === 'arbitrum' ? [MARKET] : [], entries);
        dailySlices += entries.length;
        const snap = snapshotId.get('daily', d) as { id: number } | undefined;
        if (snap) curveRows(chain, snap.id, vals, false);
      }
    }
  }
  for (const k of Object.keys(ids) as AddrKey[]) {
    for (const c of CHAINS_OF[k]) {
      const start = story.start(k, c)!;
      const startDay = Math.floor(start / DAY) * DAY;
      const total = Math.round((today - startDay) / DAY);
      histSetStart(db, ids[k], c, null, start);
      histSetProgress(db, ids[k], c, total, total);
    }
  }

  // live snapshots: every 15 minutes over the last 24 hours, with Aave rates
  const lastLive = Math.floor(nowTs / LIVE_STEP) * LIVE_STEP;
  let lastHf: number | null = null;
  for (let i = LIVE_POINTS - 1; i >= 0; i--) {
    const ts = lastLive - i * LIVE_STEP;
    const slices: ScanSlice[] = [];
    const vals: { addressId: number; v: Valued }[] = [];
    for (const k of Object.keys(ids) as AddrKey[]) {
      for (const c of CHAINS_OF[k]) {
        const v = value(story, k, c, ts, (key) => prices.at(key, ts), true);
        for (const a of v.aave) lastHf = a.healthFactor;
        slices.push({ addressId: ids[k], chain: c, balances: v.balances, positions: v.positions, aave: v.aave });
        if (c === 'ethereum') vals.push({ addressId: ids[k], v });
      }
    }
    const snap = scanWriteLiveSlices(db, ts, slices, { ethereum: [], arbitrum: [MARKET] });
    curveRows('ethereum', snap, vals, true);
    scanWriteReserveStates(
      db,
      snap,
      'arbitrum',
      RESERVES.map((r, ri) => ({
        market: MARKET,
        asset: r.asset,
        reserveId: r.reserveId,
        supplyApy: rates.apy(ri as ReserveIdx, 'supply', ts) * (1 + 0.02 * hashNoise(ts / LIVE_STEP, r.reserveId)),
        borrowApy: rates.apy(ri as ReserveIdx, 'borrow', ts) * (1 + 0.02 * hashNoise(ts / LIVE_STEP, r.reserveId + 100)),
        ltvBps: r.ltvBps,
        ltBps: r.ltBps,
        emodeCategory: 0,
      })),
    );
    scanInsertLivePrices(
      db,
      ts,
      keys.map((k) => ({ key: k, usd: prices.at(k, ts) })),
    );
  }

  // hourly history for the last 7 days (hours already covered by live snapshots are skipped)
  let hourlySlices = 0;
  for (let h = curHour - HOURLY_HOURS * HOUR; h < curHour; h += HOUR) {
    for (const chain of ['ethereum', 'arbitrum'] as ScanChain[]) {
      const entries: HistAddressDay[] = [];
      for (const k of Object.keys(ids) as AddrKey[]) {
        if (!CHAINS_OF[k].includes(chain)) continue;
        const v = value(story, k, chain, h, (key) => prices.at(key, h), false);
        entries.push({ addressId: ids[k], balances: v.balances, positions: v.positions, aave: v.aave });
      }
      hourlySlices += histWriteHourlyChainHour(db, chain, h, chain === 'arbitrum' ? [MARKET] : [], entries);
    }
  }

  const txCount = writeLedger(db, story, ids, prices);
  upsertSuggestion(db, { chain: 'ethereum', address: SUGGESTED_SAFE, ownerAddressId: ids.hot, source: 'safe' });
  scanSetMeta(db, 'worker_heartbeat', String(nowTs));
  scanSetMeta(db, 'demo_data', JSON.stringify({ generatedAt: nowTs, note: 'synthetic demo database, not real wallets' }));
  db.close();

  log.info(
    `done: 2 wallets, 3 addresses, ${dailySlices} daily slices, ${hourlySlices} hourly slices, ${LIVE_POINTS} live snapshots, ` +
      `${txCount} transactions, ${rateRows} Aave rate rows; Aave health factor now ${lastHf?.toFixed(2)}, lowest daily ${minHf.toFixed(2)}`,
  );
  console.log(`\nRun the UI on it:\n  DATABASE_PATH=${rel(file)} npm run dev\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
