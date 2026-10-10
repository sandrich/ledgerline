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
// 7 days of hourly points, 24 hours of 15 minute live snapshots, an Aave v3 position on Arbitrum
// (WETH + WBTC supplied, USDC borrowed, with rates and risk parameters), ETH / BTC / USDC holdings,
// daily / hourly / live prices from seeded random curves, USD/CHF rates and a handful of ledger
// transactions (deposits, an internal transfer, Aave supply / borrow, a swap, a send, one spam
// airdrop). Everything goes through the normal migrations and repository functions, so every API
// route works on it. The output is deterministic for a given day (seeded PRNG).
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

// ---------- tokens (public contract addresses of the real assets) ----------

const KEY = { eth: 'coingecko:ethereum', btc: 'coingecko:wrapped-bitcoin', usdc: 'coingecko:usd-coin' } as const;
type PriceKey = (typeof KEY)[keyof typeof KEY];

const T = {
  eth: {
    USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    WBTC: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
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

interface TokenInfo {
  decimals: number;
  key: PriceKey | null;
}

const TOKEN_INFO: Record<ScanChain, Record<string, TokenInfo>> = {
  ethereum: {
    [NATIVE]: { decimals: 18, key: KEY.eth },
    [T.eth.USDC]: { decimals: 6, key: KEY.usdc },
    [T.eth.WBTC]: { decimals: 8, key: KEY.btc },
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
// synthetic but realistic Aave v3 reserve parameters
const RESERVES = [
  { asset: T.arb.WETH, reserveId: 4, supplyApy: 0.019, borrowApy: 0.027, ltvBps: 8000, ltBps: 8300 },
  { asset: T.arb.WBTC, reserveId: 3, supplyApy: 0.0008, borrowApy: 0.0062, ltvBps: 7300, ltBps: 7800 },
  { asset: T.arb.USDC, reserveId: 12, supplyApy: 0.041, borrowApy: 0.056, ltvBps: 7500, ltBps: 7800 },
];

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
  [KEY.eth]: { start: 2550, end: 3350, vol: 0.032, seed: 11 },
  [KEY.btc]: { start: 59_000, end: 94_000, vol: 0.022, seed: 23 },
  [KEY.usdc]: { start: 1, end: 1, vol: 0, seed: 37 },
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

  /** Price at any time: daily path interpolated, plus hour / 15 minute noise (0 for USDC). */
  at(key: PriceKey, t: number): number {
    const p = this.paths.get(key)!;
    const x = Math.min(Math.max((t - this.firstDay) / DAY, 0), p.length - 1);
    const i = Math.floor(x);
    const j = Math.min(i + 1, p.length - 1);
    const base = Math.exp(Math.log(p[i]) + (Math.log(p[j]) - Math.log(p[i])) * (x - i));
    const vol = CURVES[key].vol;
    if (!vol) return 1 + 0.0004 * hashNoise(Math.floor(t / HOUR), 5);
    const hourly = 0.004 * hashNoise(Math.floor(t / HOUR), CURVES[key].seed);
    const quarter = 0.0015 * hashNoise(Math.floor(t / LIVE_STEP), CURVES[key].seed + 1);
    return base * (1 + hourly + quarter);
  }

  daily(key: PriceKey, dayTs: number): number {
    return this.at(key, dayTs);
  }

  get range(): { firstDay: number; days: number } {
    return { firstDay: this.firstDay, days: this.days };
  }
}

// ---------- the story: events and holdings over time ----------

interface Holding {
  token: string;
  amount: number;
  protocol: 'wallet' | 'aave-v3';
  side: 'wallet' | 'supply' | 'borrow';
}

type AddrKey = keyof typeof ADDR;

/** Event time `d` days before today at hh:00 UTC. */
function eventTs(today: number, d: number, hh = 14): number {
  return today - d * DAY + hh * HOUR;
}

class Story {
  readonly ev: Record<string, number>;
  constructor(readonly today: number) {
    const e = (d: number, hh?: number) => eventTs(today, d, hh);
    this.ev = {
      coldWbtcIn: e(720, 9),
      hotEthIn: e(700, 15),
      hotUsdcIn: e(650, 11),
      vaultFunded: e(545, 10),
      vaultSupply: e(540, 12),
      vaultBorrow: e(539, 16),
      vaultToHot: e(538, 18),
      hotToCold: e(600, 20),
      hotSwap: e(200, 13),
      hotSend: e(100, 17),
      spam: e(30, 4),
    };
  }

  holdings(who: AddrKey, chain: ScanChain, t: number): Holding[] {
    const ev = this.ev;
    const out: Holding[] = [];
    const w = (token: string, amount: number) => amount > 0 && out.push({ token, amount, protocol: 'wallet', side: 'wallet' });
    if (who === 'hot' && chain === 'ethereum') {
      let eth = 0;
      if (t >= ev.hotEthIn) eth += 5;
      if (t >= ev.hotToCold) eth -= 4;
      if (t >= ev.hotSwap) eth += 0.155;
      if (t >= ev.hotSend) eth -= 0.3;
      // gas spent over time
      const txs = [ev.hotToCold, ev.hotSwap, ev.hotSend].filter((x) => t >= x).length;
      eth -= txs * 0.0011;
      w(NATIVE, eth);
      let usdc = 0;
      if (t >= ev.hotUsdcIn) usdc += 2500;
      if (t >= ev.hotSwap) usdc -= 500;
      w(T.eth.USDC, usdc);
    }
    if (who === 'hot' && chain === 'arbitrum') {
      if (t >= ev.vaultToHot) w(T.arb.USDC, 9000);
      if (t >= ev.vaultToHot + 60) w(NATIVE, 0.012);
      if (t >= ev.spam) out.push({ token: T.arb.SPAM, amount: 1250, protocol: 'wallet', side: 'wallet' });
    }
    if (who === 'cold' && chain === 'ethereum') {
      if (t >= ev.coldWbtcIn) w(T.eth.WBTC, 0.6);
      if (t >= ev.hotToCold) w(NATIVE, 4);
    }
    if (who === 'vault' && chain === 'arbitrum') {
      if (t >= ev.vaultFunded && t < ev.vaultSupply) {
        w(T.arb.WETH, 8);
        w(T.arb.WBTC, 0.25);
      }
      if (t >= ev.vaultFunded) w(NATIVE, t >= ev.vaultToHot + 60 ? 0.008 : 0.02);
      if (t >= ev.vaultSupply) {
        const y = (t - ev.vaultSupply) / YEAR;
        out.push({ token: T.arb.aWETH, amount: 8 * Math.exp(RESERVES[0].supplyApy * y), protocol: 'aave-v3', side: 'supply' });
        out.push({ token: T.arb.aWBTC, amount: 0.25 * Math.exp(RESERVES[1].supplyApy * y), protocol: 'aave-v3', side: 'supply' });
      }
      if (t >= ev.vaultBorrow) {
        const y = (t - ev.vaultBorrow) / YEAR;
        out.push({ token: T.arb.vdUSDC, amount: 9000 * Math.exp(RESERVES[2].borrowApy * y), protocol: 'aave-v3', side: 'borrow' });
        if (t < ev.vaultToHot) w(T.arb.USDC, 9000);
      }
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
    };
    return m[`${who}|${chain}`] ?? null;
  }
}

const CHAINS_OF: Record<AddrKey, ScanChain[]> = { hot: ['ethereum', 'arbitrum'], vault: ['arbitrum'], cold: ['ethereum'] };

interface Valued {
  balances: ScanBalanceRow[];
  positions: { protocol: string; usd: number }[];
  aave: ScanAaveAccountRow[];
}

function value(holdings: Holding[], chain: ScanChain, price: (k: PriceKey) => number, withRisk: boolean): Valued {
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
  return { balances, positions, aave: accounts };
}

// ---------- ledger ----------

interface Leg {
  token: string;
  from: string;
  to: string;
  amount: number;
}

function writeLedger(db: Db, story: Story, ids: Record<AddrKey, number>, prices: Prices): number {
  const ev = story.ev;
  const txs: { chain: ScanChain; ts: number; from: string; feeEth?: number; legs: Leg[] }[] = [
    { chain: 'ethereum', ts: ev.coldWbtcIn, from: EXCHANGE, legs: [{ token: T.eth.WBTC, from: EXCHANGE, to: ADDR.cold, amount: 0.6 }] },
    { chain: 'ethereum', ts: ev.hotEthIn, from: EXCHANGE, legs: [{ token: NATIVE, from: EXCHANGE, to: ADDR.hot, amount: 5 }] },
    { chain: 'ethereum', ts: ev.hotUsdcIn, from: FRIEND, legs: [{ token: T.eth.USDC, from: FRIEND, to: ADDR.hot, amount: 2500 }] },
    { chain: 'ethereum', ts: ev.hotToCold, from: ADDR.hot, feeEth: 0.0011, legs: [{ token: NATIVE, from: ADDR.hot, to: ADDR.cold, amount: 4 }] },
    {
      chain: 'ethereum',
      ts: ev.hotSwap,
      from: ADDR.hot,
      feeEth: 0.0011,
      legs: [
        { token: T.eth.USDC, from: ADDR.hot, to: ROUTER, amount: 500 },
        { token: NATIVE, from: ROUTER, to: ADDR.hot, amount: 0.155 },
      ],
    },
    { chain: 'ethereum', ts: ev.hotSend, from: ADDR.hot, feeEth: 0.0011, legs: [{ token: NATIVE, from: ADDR.hot, to: FRIEND, amount: 0.3 }] },
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
      from: ADDR.vault,
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
      from: ADDR.vault,
      legs: [
        { token: T.arb.vdUSDC, from: NATIVE, to: ADDR.vault, amount: 9000 },
        { token: T.arb.USDC, from: T.arb.aUSDC, to: ADDR.vault, amount: 9000 },
      ],
    },
    { chain: 'arbitrum', ts: ev.vaultToHot, from: ADDR.vault, legs: [{ token: T.arb.USDC, from: ADDR.vault, to: ADDR.hot, amount: 9000 }] },
    { chain: 'arbitrum', ts: ev.vaultToHot + 60, from: ADDR.vault, legs: [{ token: NATIVE, from: ADDR.vault, to: ADDR.hot, amount: 0.012 }] },
    { chain: 'arbitrum', ts: ev.spam, from: SPAMMER, legs: [{ token: T.arb.SPAM, from: SPAMMER, to: ADDR.hot, amount: 1250 }] },
  ];
  const own = new Map<string, number>([
    [ADDR.hot, ids.hot],
    [ADDR.vault, ids.vault],
    [ADDR.cold, ids.cold],
  ]);
  const insTx = db.prepare('INSERT OR REPLACE INTO tx (chain, hash, block, ts, from_addr, receipt, fee_wei, fee_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insTr = db.prepare(
    `INSERT OR REPLACE INTO tx_transfers (chain, hash, ref, token, from_addr, to_addr, amount_raw, amount, usd, kind_hint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAddr = db.prepare('INSERT OR IGNORE INTO tx_addresses (address_id, chain, hash, ts) VALUES (?, ?, ?, ?)');
  const blockAt = (chain: ScanChain, ts: number) => (chain === 'ethereum' ? Math.floor((ts - 1_438_269_973) / 12) : Math.floor((ts - 1_622_243_344) * 4));
  db.transaction(() => {
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
    const now = Math.floor(Date.now() / 1000);
    const st = db.prepare(
      `INSERT OR REPLACE INTO ledger_state (address_id, chain, last_block, native_block, updated_at, error) VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    for (const k of Object.keys(ADDR) as AddrKey[]) {
      for (const c of CHAINS_OF[k]) st.run(ids[k], c, blockAt(c, now), blockAt(c, now), now);
    }
  })();
  return txs.length;
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
  const story = new Story(today);

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
  const held: Record<AddrKey, Partial<Record<ScanChain, string[]>>> = {
    hot: { ethereum: [NATIVE, T.eth.USDC], arbitrum: [NATIVE, T.arb.USDC, T.arb.SPAM] },
    vault: { arbitrum: [NATIVE, T.arb.WETH, T.arb.WBTC, T.arb.USDC] },
    cold: { ethereum: [NATIVE, T.eth.WBTC] },
  };
  for (const k of Object.keys(held) as AddrKey[]) {
    for (const [c, list] of Object.entries(held[k]) as [ScanChain, string[]][]) for (const t of list) scanAddAddressToken(db, ids[k], c, t, null);
  }

  // prices and FX
  const keys = Object.values(KEY);
  const daily: { key: string; ts: number; usd: number }[] = [];
  for (let d = firstDay; d <= today; d += DAY) for (const k of keys) daily.push({ key: k, ts: d, usd: prices.daily(k, d) });
  histInsertDailyPrices(db, daily);
  const curHour = Math.floor(nowTs / HOUR) * HOUR;
  const hourly: { key: string; ts: number; usd: number }[] = [];
  for (let h = curHour - (HOURLY_HOURS + 24) * HOUR; h < curHour; h += HOUR) for (const k of keys) hourly.push({ key: k, ts: h, usd: prices.at(k, h) });
  histInsertHourlyPrices(db, hourly);
  const fxRnd = mulberry32(53);
  let chf = 0.905;
  const fx: { day: string; usdChf: number }[] = [];
  for (let d = firstDay; d <= today; d += DAY) {
    chf = Math.min(0.95, Math.max(0.78, chf * (1 + gaussian(fxRnd) * 0.0035) - (chf - 0.85) * 0.002));
    const wd = new Date(d * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) fx.push({ day: new Date(d * 1000).toISOString().slice(0, 10), usdChf: Math.round(chf * 1e4) / 1e4 });
  }
  histInsertFx(db, fx);

  // daily history: every completed day from each slice's first activity
  let dailySlices = 0;
  for (let d = firstDay; d < today; d += DAY) {
    const endOfDay = d + DAY - 1;
    for (const chain of ['ethereum', 'arbitrum'] as ScanChain[]) {
      const entries: HistAddressDay[] = [];
      for (const k of Object.keys(ids) as AddrKey[]) {
        const start = story.start(k, chain);
        if (start == null || endOfDay < Math.floor(start / DAY) * DAY) continue;
        const v = value(story.holdings(k, chain, endOfDay), chain, (key) => prices.daily(key, d), false);
        entries.push({ addressId: ids[k], balances: v.balances, positions: v.positions, aave: v.aave });
      }
      if (entries.length) {
        histWriteDailyChainDay(db, chain, d, chain === 'arbitrum' ? [MARKET] : [], entries);
        dailySlices += entries.length;
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
  for (let i = LIVE_POINTS - 1; i >= 0; i--) {
    const ts = lastLive - i * LIVE_STEP;
    const slices: ScanSlice[] = [];
    for (const k of Object.keys(ids) as AddrKey[]) {
      for (const c of CHAINS_OF[k]) {
        const v = value(story.holdings(k, c, ts), c, (key) => prices.at(key, ts), true);
        slices.push({ addressId: ids[k], chain: c, balances: v.balances, positions: v.positions, aave: v.aave });
      }
    }
    const snap = scanWriteLiveSlices(db, ts, slices, { ethereum: [], arbitrum: [MARKET] });
    scanWriteReserveStates(
      db,
      snap,
      'arbitrum',
      RESERVES.map((r) => ({
        market: MARKET,
        asset: r.asset,
        reserveId: r.reserveId,
        supplyApy: r.supplyApy * (1 + 0.05 * hashNoise(ts / LIVE_STEP, r.reserveId)),
        borrowApy: r.borrowApy * (1 + 0.05 * hashNoise(ts / LIVE_STEP, r.reserveId + 100)),
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
        const v = value(story.holdings(k, chain, h), chain, (key) => prices.at(key, h), false);
        entries.push({ addressId: ids[k], balances: v.balances, positions: v.positions, aave: v.aave });
      }
      hourlySlices += histWriteHourlyChainHour(db, chain, h, chain === 'arbitrum' ? [MARKET] : [], entries);
    }
  }

  const txCount = writeLedger(db, story, ids, prices);
  scanSetMeta(db, 'worker_heartbeat', String(nowTs));
  scanSetMeta(db, 'demo_data', JSON.stringify({ generatedAt: nowTs, note: 'synthetic demo database, not real wallets' }));
  db.close();

  log.info(
    `done: 2 wallets, 3 addresses, ${dailySlices} daily slices, ${hourlySlices} hourly slices, ${LIVE_POINTS} live snapshots, ${txCount} transactions`,
  );
  console.log(`\nRun the UI on it:\n  DATABASE_PATH=${rel(file)} npm run dev\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
