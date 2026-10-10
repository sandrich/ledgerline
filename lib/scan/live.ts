// Live snapshot.
// Per chain: ONE multicall at (near) latest for every tracked address: native balance + all known
// wallet tokens + every Aave reserve's aToken / debt tokens + getUserAccountData per market.
// Current prices for all canonical keys in one DefiLlama POST (chunked at 200). Writes a live
// snapshot (ts rounded to the minute) with balances, position_values ('wallet' always, 'aave-v3'
// when any position exists), aave_accounts, and the current prices at live granularity.
import { formatUnits } from 'viem';
import {
  NATIVE,
  SCAN_CHAINS,
  scanEnsureNativeToken,
  scanInsertLivePrices,
  scanListAddressTokens,
  scanListAddresses,
  scanSetMeta,
  scanSetTokenSpam,
  scanWriteLiveSlices,
  scanCarryForward,
  scanWriteReserveStates,
  type ScanAaveAccountRow,
  type ScanAddress,
  type ScanReserveState,
  type ScanAddressToken,
  type ScanChain,
  type ScanSlice,
} from '../db/repos-scan';
import {
  ReserveCache,
  call,
  decodeAccountData,
  decodeEMode,
  decodeReserveRisk,
  encAccountData,
  encBalanceOf,
  encEModeCalls,
  encReserveData,
  encUserConfiguration,
  encUserEMode,
  marketsForChain,
  type EModeConfig,
  type ReserveTokens,
} from '../history/aave';
import { decodeUint, multicallAt, nativeBalanceCall, type HistCall } from '../history/multicall';
import { ETH_KEY, canonicalPriceKey } from '../history/price-keys';
import { throwIfAborted, type Db } from '../history/types';
import { errMsg, type Logger } from './log';
import { HEAD_LAG, headBlock, latestRpc } from './rpc-latest';
import { nameLooksSpam } from './spam';
import { fetchCurrentPrices, minuteTs, priceOf, type PriceLookup } from './valuation';

export interface RunLiveSnapshotOptions {
  db: Db;
  log: Logger;
  signal?: AbortSignal;
  chains?: ScanChain[];
  /** Snapshot timestamp override (unix seconds, rounded to the minute). */
  ts?: number;
}

export interface LiveChainResult {
  block: number;
  addresses: number;
  calls: number;
  walletUsd: number;
  aaveUsd: number;
  error?: string;
}

export interface LiveSnapshotResult {
  ts: number;
  snapshotId: number | null;
  totalUsd: number;
  chains: Partial<Record<ScanChain, LiveChainResult>>;
  prices: number;
  durationMs: number;
}

const AAVE_KINDS = new Set(['atoken', 'vdebt', 'sdebt']);

type Slot =
  | { t: 'native'; a: number }
  | { t: 'wallet'; a: number; token: ScanAddressToken }
  | { t: 'aave'; a: number; r: ReserveTokens; side: 'supply' | 'vdebt' | 'sdebt' }
  | { t: 'acct'; a: number; market: string };

interface ChainRead {
  chain: ScanChain;
  block: number;
  addrs: ScanAddress[];
  slots: Slot[];
  raws: bigint[];
  accts: Map<string, Omit<ScanAaveAccountRow, 'market'>>; // `${a}|${market}`
  /** reserve rates / risk parameters; empty when those reads failed (risk KPIs then stay null) */
  reserveStates: ScanReserveState[];
}

/**
 * Rates, LTV / liquidation thresholds per reserve and every user's eMode + collateral bitmap, in a
 * separate multicall so a Pool version without one of these calls never breaks the balance read.
 * Mutates `accts` (adds the user fields) and returns the reserve states.
 */
async function readRisk(
  chain: ScanChain,
  rpc: ReturnType<typeof latestRpc>,
  block: number,
  reserves: ReserveCache,
  held: Set<string>,
  addrs: ScanAddress[],
  accts: ChainRead['accts'],
  log: Logger,
  signal?: AbortSignal,
): Promise<ScanReserveState[]> {
  const markets = marketsForChain(chain);
  const calls: HistCall[] = [];
  const rSlots: { market: string; asset: string }[] = [];
  for (const m of markets) {
    for (const r of reserves.reserves(m.key)) {
      // only reserves someone holds (supplied or borrowed): ~3 rows per snapshot instead of ~110
      if (!held.has(`${m.key}|${r.asset}`)) continue;
      calls.push(call(m.pool, encReserveData(r.asset)));
      rSlots.push({ market: m.key, asset: r.asset });
    }
  }
  const uStart = calls.length;
  // user reads only for accounts with a position (others have nothing to assess)
  const users: { a: number; market: string; pool: string }[] = [];
  addrs.forEach((addr, a) => {
    for (const m of markets) {
      if (!accts.has(`${a}|${m.key}`)) continue;
      calls.push(call(m.pool, encUserEMode(addr.address)));
      calls.push(call(m.pool, encUserConfiguration(addr.address)));
      users.push({ a, market: m.key, pool: m.pool });
    }
  });
  const res = await multicallAt(rpc, chain, block, calls, signal);
  const states: ScanReserveState[] = [];
  rSlots.forEach((x, i) => {
    const d = decodeReserveRisk(x.asset, res[i]);
    if (d) states.push({ market: x.market, ...d });
  });
  const cats = new Map<string, number>(); // `${pool}|${cat}` -> category
  const userInfo = users.map((u, i) => {
    const em = res[uStart + i * 2];
    const cfg = res[uStart + i * 2 + 1];
    const emode = em?.success && em.data.length >= 66 ? Number(BigInt(em.data.slice(0, 66))) : null;
    const userConfig = cfg?.success && cfg.data.length >= 66 ? BigInt(cfg.data.slice(0, 66)).toString() : null;
    if (emode) cats.set(`${u.pool}|${emode}`, emode);
    return { ...u, emode, userConfig };
  });
  const emodes = new Map<string, EModeConfig | null>();
  if (cats.size) {
    const eCalls: HistCall[] = [];
    const keys = [...cats.keys()];
    for (const k of keys) {
      const [pool] = k.split('|');
      const c = encEModeCalls(cats.get(k)!);
      eCalls.push(call(pool, c.data), call(pool, c.collateral), call(pool, c.bitmap));
    }
    const er = await multicallAt(rpc, chain, block, eCalls, signal);
    keys.forEach((k, i) => emodes.set(k, decodeEMode(er[i * 3], er[i * 3 + 1], er[i * 3 + 2])));
  }
  for (const u of userInfo) {
    const acct = accts.get(`${u.a}|${u.market}`);
    if (!acct) continue;
    acct.emode = u.emode;
    acct.userConfig = u.userConfig;
    if (u.emode) {
      const e = emodes.get(`${u.pool}|${u.emode}`);
      if (!e) log.warn(`live ${chain}: eMode ${u.emode} config unreadable on ${u.market}`);
      acct.emodeLtvBps = e?.ltvBps ?? null;
      acct.emodeLtBps = e?.ltBps ?? null;
      acct.emodeBitmap = e?.collateralBitmap ?? null;
    }
  }
  return states;
}

function walletKey(chain: ScanChain, t: ScanAddressToken): string {
  return t.price_key ?? canonicalPriceKey(chain, t.address);
}

async function readChain(db: Db, chain: ScanChain, addrs: ScanAddress[], log: Logger, signal?: AbortSignal): Promise<ChainRead> {
  const rpc = latestRpc(chain, log);
  const block = (await headBlock(rpc, signal)) - HEAD_LAG[chain];
  scanEnsureNativeToken(db, chain);
  const reserves = new ReserveCache(db, chain, rpc, log);
  try {
    const added = await reserves.refreshAt(block, signal);
    if (added) log.info(`live ${chain}: registered ${added} new Aave reserves`);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`live ${chain}: reserve refresh failed, using cached reserves`, { error: errMsg(e) });
  }
  const markets = marketsForChain(chain);
  const allReserves = reserves.all();

  const calls: HistCall[] = [];
  const slots: Slot[] = [];
  addrs.forEach((addr, a) => {
    calls.push(nativeBalanceCall(addr.address));
    slots.push({ t: 'native', a });
    for (const t of scanListAddressTokens(db, addr.id, chain)) {
      if (t.address === NATIVE || t.kind === 'native' || (t.kind && AAVE_KINDS.has(t.kind)) || t.decimals == null) continue;
      if (reserves.isPositionToken(t.address)) continue; // valued as an Aave position, never also as a wallet token
      calls.push(call(t.address, encBalanceOf(addr.address)));
      slots.push({ t: 'wallet', a, token: t });
    }
    for (const r of allReserves) {
      calls.push(call(r.aToken, encBalanceOf(addr.address)));
      slots.push({ t: 'aave', a, r, side: 'supply' });
      calls.push(call(r.vDebt, encBalanceOf(addr.address)));
      slots.push({ t: 'aave', a, r, side: 'vdebt' });
      if (r.sDebt) {
        calls.push(call(r.sDebt, encBalanceOf(addr.address)));
        slots.push({ t: 'aave', a, r, side: 'sdebt' });
      }
    }
    for (const m of markets) {
      calls.push(call(m.pool, encAccountData(addr.address)));
      slots.push({ t: 'acct', a, market: m.key });
    }
  });

  const res = await multicallAt(rpc, chain, block, calls, signal);
  const raws: bigint[] = [];
  const accts: ChainRead['accts'] = new Map();
  slots.forEach((s, i) => {
    // At the head block every cached reserve and market exists, so a failed Aave sub-call is an
    // RPC-side failure (e.g. gas starvation in a large aggregate3), not "no position": fail the
    // chain read so the snapshot carries the previous slice forward instead of dipping.
    if ((s.t === 'acct' || s.t === 'aave') && !res[i]?.success) {
      throw new Error(`Aave sub-call failed (${s.t === 'acct' ? `getUserAccountData ${s.market}` : `${s.side} ${s.r.asset}`}) at block ${block}`);
    }
    if (s.t === 'acct') {
      const d = decodeAccountData(res[i]);
      if (d) accts.set(`${s.a}|${s.market}`, d);
      raws.push(0n);
    } else raws.push(decodeUint(res[i]));
  });
  let reserveStates: ScanReserveState[] = [];
  const held = new Set<string>();
  slots.forEach((s, i) => {
    if (s.t === 'aave' && raws[i] !== 0n) held.add(`${s.r.market}|${s.r.asset}`);
  });
  try {
    if (held.size) reserveStates = await readRisk(chain, rpc, block, reserves, held, addrs, accts, log, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`live ${chain}: Aave rates / risk read failed, risk KPIs stay empty this round`, { error: errMsg(e) });
  }
  return { chain, block, addrs, slots, raws, accts, reserveStates };
}

export async function runLiveSnapshot(opts: RunLiveSnapshotOptions): Promise<LiveSnapshotResult> {
  const t0 = Date.now();
  const { db, log, signal } = opts;
  const ts = opts.ts ?? minuteTs();
  const chains = opts.chains ?? SCAN_CHAINS;
  const addresses = scanListAddresses(db);
  const result: LiveSnapshotResult = { ts, snapshotId: null, totalUsd: 0, chains: {}, prices: 0, durationMs: 0 };
  if (!addresses.length) {
    log.info('live snapshot: no addresses');
    result.durationMs = Date.now() - t0;
    return result;
  }

  // 1. Read all chains in parallel (RPC-heavy work stays serialized per chain inside the pools).
  const reads = (
    await Promise.all(
      chains.map(async (chain) => {
        const addrs = addresses.filter((a) => a.chains.includes(chain));
        if (!addrs.length) return null;
        try {
          return await readChain(db, chain, addrs, log, signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          log.error(`live ${chain}: read failed`, { error: errMsg(e) });
          result.chains[chain] = { block: 0, addresses: addrs.length, calls: 0, walletUsd: 0, aaveUsd: 0, error: errMsg(e) };
          return null;
        }
      }),
    )
  ).filter((r): r is ChainRead => !!r);
  throwIfAborted(signal);
  if (!reads.length) throw new Error('live snapshot: no chain could be read');

  // 2. Prices for every key with a non-zero balance (plus ETH), one POST per 200 keys.
  const keys = new Set<string>([ETH_KEY]);
  for (const r of reads) {
    r.slots.forEach((s, i) => {
      if (r.raws[i] === 0n) return;
      if (s.t === 'wallet') keys.add(walletKey(r.chain, s.token));
      else if (s.t === 'aave') keys.add(s.r.priceKey);
    });
  }
  const lookup: PriceLookup = await fetchCurrentPrices([...keys], log, signal);
  if (!lookup.prices.size) throw new Error('live snapshot: no current prices (DefiLlama unreachable), not writing a zero snapshot');
  result.prices = lookup.prices.size;

  // 3. Value and build slices.
  const slices: ScanSlice[] = [];
  const marketsByChain = Object.fromEntries(SCAN_CHAINS.map((c) => [c, marketsForChain(c).map((m) => m.key)])) as Record<ScanChain, string[]>;
  for (const r of reads) {
    const per = r.addrs.map((addr) => ({
      slice: { addressId: addr.id, chain: r.chain, balances: [], positions: [], aave: [] } as ScanSlice,
      wallet: 0,
      aave: 0,
      aaveAny: false,
    }));
    r.slots.forEach((s, i) => {
      const raw = r.raws[i];
      if (s.t === 'acct' || raw === 0n) return;
      const p = per[s.a];
      if (s.t === 'native') {
        const amount = Number(formatUnits(raw, 18));
        const usd = amount * (priceOf(lookup, ETH_KEY) ?? 0);
        p.wallet += usd;
        p.slice.balances.push({ token: NATIVE, amountRaw: raw.toString(), amount, usd, protocol: 'wallet', side: 'wallet' });
      } else if (s.t === 'wallet') {
        const key = walletKey(r.chain, s.token);
        const px = priceOf(lookup, key);
        // No price for a held token => hidden/spam; never un-flag here.
        if (px === undefined && lookup.answered.has(key) && !s.token.spam && !key.startsWith('coingecko:')) {
          scanSetTokenSpam(db, r.chain, s.token.address, true);
          s.token.spam = 1;
          log.info(`live ${r.chain}: ${s.token.symbol ?? s.token.address} has no price, flagged hidden`);
        } else if (!s.token.spam && nameLooksSpam(s.token.symbol, s.token.name)) {
          scanSetTokenSpam(db, r.chain, s.token.address, true);
          s.token.spam = 1;
        }
        const amount = Number(formatUnits(raw, s.token.decimals!));
        const usd = s.token.spam ? 0 : amount * (px ?? 0);
        p.wallet += usd;
        p.slice.balances.push({ token: s.token.address, amountRaw: raw.toString(), amount, usd, protocol: 'wallet', side: 'wallet' });
      } else {
        const amount = Number(formatUnits(raw, s.r.decimals));
        const px = priceOf(lookup, s.r.priceKey) ?? 0;
        const sign = s.side === 'supply' ? 1 : -1; // underlying price is positive; debt negated here
        const usd = sign * amount * px;
        p.aave += usd;
        p.aaveAny = true;
        const token = s.side === 'supply' ? s.r.aToken : s.side === 'vdebt' ? s.r.vDebt : s.r.sDebt!;
        p.slice.balances.push({ token, amountRaw: raw.toString(), amount, usd, protocol: 'aave-v3', side: s.side === 'supply' ? 'supply' : 'borrow' });
      }
    });
    let walletUsd = 0;
    let aaveUsd = 0;
    per.forEach((p, a) => {
      p.slice.positions.push({ protocol: 'wallet', usd: p.wallet });
      if (p.aaveAny) p.slice.positions.push({ protocol: 'aave-v3', usd: p.aave });
      for (const m of marketsByChain[r.chain]) {
        const acct = r.accts.get(`${a}|${m}`);
        if (acct && (acct.collateralUsd > 0 || acct.debtUsd > 0)) p.slice.aave.push({ market: m, ...acct });
      }
      walletUsd += p.wallet;
      aaveUsd += p.aave;
      slices.push(p.slice);
    });
    result.chains[r.chain] = { block: r.block, addresses: r.addrs.length, calls: r.slots.length, walletUsd, aaveUsd };
    result.totalUsd += walletUsd + aaveUsd;
  }

  // 4. Write.
  throwIfAborted(signal);
  result.snapshotId = scanWriteLiveSlices(db, ts, slices, marketsByChain);
  for (const r of reads) scanWriteReserveStates(db, result.snapshotId, r.chain, r.reserveStates);
  // A chain that could not be read keeps its previous values (otherwise totals would dip to zero).
  for (const chain of chains) {
    if (reads.some((r) => r.chain === chain)) continue;
    const ids = addresses.filter((a) => a.chains.includes(chain)).map((a) => a.id);
    const n = scanCarryForward(db, result.snapshotId, ts, chain, ids, marketsByChain[chain]);
    if (n) log.warn(`live ${chain}: carried ${n} address slice(s) forward from the previous snapshot`);
  }
  scanInsertLivePrices(
    db,
    ts,
    [...keys].map((k) => ({ key: k, usd: priceOf(lookup, k) })).filter((p): p is { key: string; usd: number } => p.usd !== undefined),
  );
  scanSetMeta(db, 'last_snapshot_at', String(ts));
  result.durationMs = Date.now() - t0;
  log.info(`live snapshot ${new Date(ts * 1000).toISOString()} written: $${Math.round(result.totalUsd).toLocaleString('en-US')}`, {
    snapshotId: result.snapshotId,
    chains: result.chains,
    prices: result.prices,
    ms: result.durationMs,
  });
  return result;
}
