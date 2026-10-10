// Daily history backfill.
// Per chain: start day per address (discovery_state.start_ts or computed), every UTC day from the
// start day to yesterday, newest first. Block per day via DefiLlama (cached in `blocks`), ONE
// multicall per (chain, day) batching all addresses: native + wallet tokens + every Aave reserve
// token + getUserAccountData. Valued with daily prices; written into the shared daily snapshot.
//
// Conventions: daily snapshot ts = UTC day start of day D; it holds the state at the END of D,
// i.e. at the first block at/after D+1 00:00 UTC, valued with the D+1 00:00 daily price.
import { formatUnits, type Hex } from 'viem';
import {
  histClearRedo,
  histDoneDays,
  histGetRedoFrom,
  histGetBlock,
  histGetDiscoveryState,
  histGetMeta,
  histListAddresses,
  histListAddressTokens,
  histLoadDailyPrices,
  histPutBlock,
  histSetMeta,
  histSetProgress,
  histSetStart,
  histWriteDailyChainDay,
  histWriteHourlyChainHour,
  type HistAddress,
  type HistAddressDay,
  type HistAddressToken,
  type HistBalanceRow,
} from '../db/repos-history';
import {
  call,
  decodeAccountData,
  decodeReservesList,
  encAccountData,
  encBalanceOf,
  encReservesList,
  marketsForChain,
  ReserveCache,
  type ReserveTokens,
} from './aave';
import { fetchJson } from './http';
import { MULTICALL3_DEPLOY_BLOCK, decodeUint, multicallAt, nativeBalanceCall, type HistCall } from './multicall';
import { ETH_KEY, canonicalPriceKey } from './price-keys';
import { priceForDayEnd, syncPriceHistory } from './prices';
import { archiveRpc, type RpcPool } from './rpc';
import { computeStart } from './start';
import {
  DAY,
  HISTORY_CHAINS,
  NATIVE_TOKEN,
  dayStart,
  isoDay,
  mapLimit,
  nowSec,
  throwIfAborted,
  type Db,
  type HistoryChain,
  type HistoryJobOptions,
  type HistoryLogger,
} from './types';

export interface RunBackfillOptions extends HistoryJobOptions {
  /** Restrict to one address (e.g. right after it was added). Default: all addresses. */
  addressId?: number;
  /** Restrict chains (default both). */
  chains?: HistoryChain[];
  /** Parallel days in flight per chain (default 4; RPC pool throttles per endpoint anyway). */
  concurrency?: number;
  /** Re-write days that were already written. */
  redo?: boolean;
  /** Progress callback (days done / total over the whole run). */
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillChainResult {
  addresses: number;
  days: number;
  processed: number;
  failed: number;
  skippedInactive: number;
}

export interface BackfillResult {
  chains: Partial<Record<HistoryChain, BackfillChainResult>>;
  durationMs: number;
}

interface AddrPlan {
  addr: HistAddress;
  startDay: number;
  /** Durable redo marker (set by discovery when a new token appeared): days >= this are rewritten. */
  redoFrom: number | null;
  walletTokens: HistAddressToken[];
  done: Set<number>;
  total: number;
}

interface ChainPlan {
  chain: HistoryChain;
  rpc: RpcPool;
  reserves: ReserveCache;
  addrs: AddrPlan[];
  skippedInactive: number;
  /** Readable per-address planning problems; they fail the job (and are shown on the manage page). */
  planErrors: string[];
}

/** meta key holding the last readable backfill error of an (address, chain); '' = none. */
const errorKey = (addressId: number, chain: HistoryChain) => `history:error:${addressId}:${chain}`;

const AAVE_KINDS = new Set(['atoken', 'vdebt', 'sdebt']);
const ARB_NITRO_TS = 1661904000; // 2022-08-31 00:00 UTC
const INACTIVE_RECHECK = 6 * 3600;

export async function runBackfill(opts: RunBackfillOptions): Promise<BackfillResult> {
  const t0 = Date.now();
  const { db, log, signal } = opts;
  const chains = opts.chains ?? HISTORY_CHAINS;
  const addresses = histListAddresses(db, opts.addressId);
  const result: BackfillResult = { chains: {}, durationMs: 0 };
  if (!addresses.length) {
    log.info('backfill: no addresses');
    result.durationMs = Date.now() - t0;
    return result;
  }
  const yesterday = dayStart(nowSec()) - DAY;

  // 1. Plan per chain (start days, tokens, Aave reserves) in parallel.
  const plans = (
    await Promise.all(
      chains.map((chain) =>
        planChain(db, chain, addresses.filter((a) => a.chains.includes(chain)), yesterday, opts).catch((e) => {
          if (signal?.aborted) throw e;
          log.error(`backfill: planning failed on ${chain}`, { error: String(e).slice(0, 300) });
          return null;
        }),
      ),
    )
  ).filter((p): p is ChainPlan => !!p);

  // 2. Make sure daily prices exist for every key we will value with.
  const keys = new Set<string>([ETH_KEY]);
  let earliest = yesterday;
  for (const p of plans) {
    if (!p.addrs.length) continue;
    for (const r of p.reserves.all()) keys.add(r.priceKey);
    for (const a of p.addrs) {
      earliest = Math.min(earliest, a.startDay);
      for (const t of a.walletTokens) keys.add(tokenPriceKey(p.chain, t));
    }
  }
  // Keys whose price download failed in this run: a missing price for them is an error (the day
  // is retried next run), not "no price history" (which values the token at $0 and flags the day).
  const failedPriceKeys = new Set<string>();
  const ph = await syncPriceHistory({ db, log, signal, keys: [...keys], fromTs: earliest });
  for (const k of ph.failedKeys) failedPriceKeys.add(k);
  const prices = histLoadDailyPrices(db, [...keys], earliest - 8 * DAY);
  const ensureKey = async (key: string) => {
    if (prices.has(key) && prices.get(key)!.size) return;
    const r = await syncPriceHistory({ db, log, signal, keys: [key], fromTs: earliest, fx: false });
    for (const k of r.failedKeys) failedPriceKeys.add(k);
    prices.set(key, histLoadDailyPrices(db, [key], earliest - 8 * DAY).get(key)!);
  };
  const ctx: DayContext = { prices, ensureKey, failedPriceKeys };

  // 3. Walk days per chain (chains in parallel, days newest first).
  const grandTotal = plans.reduce((s, p) => s + p.addrs.reduce((x, a) => x + a.total, 0), 0);
  let grandDone = plans.reduce((s, p) => s + p.addrs.reduce((x, a) => x + a.done.size, 0), 0);
  await Promise.all(
    plans.map(async (plan) => {
      const res: BackfillChainResult = { addresses: plan.addrs.length, days: 0, processed: 0, failed: 0, skippedInactive: plan.skippedInactive };
      result.chains[plan.chain] = res;
      if (!plan.addrs.length) return;
      const minDay = Math.min(...plan.addrs.map((a) => a.startDay));
      const days: number[] = [];
      for (let d = yesterday; d >= minDay; d -= DAY) {
        if (plan.addrs.some((a) => d >= a.startDay && (opts.redo || !a.done.has(d)))) days.push(d);
      }
      let stopped = false;
      res.days = days.length;
      log.info(`backfill ${plan.chain}: ${days.length} days to process (${isoDay(minDay)}..${isoDay(yesterday)}), ${plan.addrs.length} addresses`);
      let consecutiveFailures = 0;
      let processed = 0;
      await mapLimit(days, opts.concurrency ?? 4, async (day) => {
        throwIfAborted(signal);
        if (consecutiveFailures >= 12) {
          stopped = true;
          return; // endpoint pool is clearly down; resume next run
        }
        const todo = plan.addrs.filter((a) => day >= a.startDay && (opts.redo || !a.done.has(day)));
        try {
          await processDay(db, plan, day, todo, ctx, log, signal);
          consecutiveFailures = 0;
          for (const a of todo) {
            if (!a.done.has(day)) grandDone++;
            a.done.add(day);
            histSetProgress(db, a.addr.id, plan.chain, Math.min(a.done.size, a.total), a.total);
          }
          res.processed++;
          processed++;
          opts.onProgress?.(grandDone, grandTotal);
          if (processed % 50 === 0) log.info(`backfill ${plan.chain}: ${processed}/${days.length} days (at ${isoDay(day)})`);
        } catch (e) {
          if (signal?.aborted) throw e;
          consecutiveFailures++;
          res.failed++;
          log.warn(`backfill ${plan.chain} ${isoDay(day)} failed`, { error: String(e).slice(0, 300) });
        }
      });
      if (stopped) log.error(`backfill ${plan.chain}: stopped after repeated failures, will resume next run`);
      // Clear redo markers whose whole range was rewritten in this run (else they stay for the next run).
      for (const a of plan.addrs) {
        if (a.redoFrom == null) continue;
        let complete = true;
        for (let d = Math.max(a.redoFrom, a.startDay); d <= yesterday && complete; d += DAY) complete = a.done.has(d);
        if (complete) histClearRedo(db, a.addr.id, plan.chain, a.redoFrom);
      }
      res.days = days.length;
      res.failed += stopped ? days.length - res.processed - res.failed : 0;
    }),
  );
  result.durationMs = Date.now() - t0;
  log.info(`backfill finished in ${(result.durationMs / 1000).toFixed(1)}s`, { chains: result.chains });
  const failed = Object.values(result.chains).reduce((n, c) => n + (c?.failed ?? 0), 0);
  const planErrors = plans.flatMap((p) => p.planErrors);
  // Fail the job so it shows up as failed; the days stay "not done" and the next run retries them.
  if (planErrors.length) throw new Error(planErrors.join('; '));
  if (failed > 0) throw new Error(`backfill: ${failed} day(s) could not be processed and will be retried on the next run`);
  return result;
}

function tokenPriceKey(chain: HistoryChain, t: HistAddressToken): string {
  return t.price_key ?? canonicalPriceKey(chain, t.address);
}

async function planChain(
  db: Db,
  chain: HistoryChain,
  addresses: HistAddress[],
  yesterday: number,
  opts: RunBackfillOptions,
): Promise<ChainPlan> {
  const { log, signal } = opts;
  const rpc = archiveRpc(chain, log);
  const reserves = new ReserveCache(db, chain, rpc, log);
  const plan: ChainPlan = { chain, rpc, reserves, addrs: [], skippedInactive: 0, planErrors: [] };
  if (!addresses.length) return plan;
  const latest = Number(BigInt(await rpc.request<Hex>('eth_blockNumber', [], signal)));
  const added = await reserves.refreshAt(latest, signal);
  if (added) log.info(`backfill ${chain}: registered ${added} Aave reserves`);

  for (const addr of addresses) {
    throwIfAborted(signal);
    const st = await resolveStart(db, chain, addr, rpc, log, signal, !!opts.redo);
    if (st.state === 'inactive') {
      plan.skippedInactive++;
      continue;
    }
    if (st.state === 'error') {
      plan.planErrors.push(`${addr.address} on ${chain}: ${st.msg}`);
      continue;
    }
    const startDay = dayStart(st.startTs);
    if (startDay > yesterday) {
      histSetProgress(db, addr.id, chain, 0, 0);
      continue;
    }
    const walletTokens = walletTokensFor(db, addr.id, chain, reserves);
    const total = Math.round((yesterday - startDay) / DAY) + 1;
    const redoFrom = histGetRedoFrom(db, addr.id, chain);
    const done = new Set(
      [...histDoneDays(db, addr.id, chain)].filter((d) => d >= startDay && d <= yesterday && (redoFrom == null || d < redoFrom)),
    );
    if (redoFrom != null) log.info(`backfill ${chain}: ${addr.address} rewrites days from ${isoDay(Math.max(redoFrom, startDay))} (new tokens found)`);
    histSetProgress(db, addr.id, chain, done.size, total);
    plan.addrs.push({ addr, startDay, redoFrom, walletTokens, done, total });
  }
  // Arbitrum state before the Nitro migration (block 22207817, 2022-08-31) is only served by a few
  // archive endpoints (keyless: blastapi only; tenderly answers "missing trie node").
  if (chain === 'arbitrum' && !process.env.ARB_ARCHIVE_RPC_URL && plan.addrs.some((a) => a.startDay < ARB_NITRO_TS)) {
    log.warn('backfill arbitrum: history before 2022-08-31 (pre-Nitro) depends on a single keyless archive endpoint; set ARB_ARCHIVE_RPC_URL for reliable deep history');
  }
  return plan;
}

export type StartResolution = { state: 'active'; startTs: number } | { state: 'inactive' } | { state: 'error'; msg: string };

/**
 * First activity of an (address, chain): discovery_state.start_ts when known, else computed (and
 * stored). Inactive pairs are re-checked at most once per INACTIVE_RECHECK (unless `force`).
 * Shared by the daily and the hourly backfill (whichever runs first computes it).
 */
export async function resolveStart(
  db: Db,
  chain: HistoryChain,
  addr: HistAddress,
  rpc: RpcPool,
  log: HistoryLogger,
  signal?: AbortSignal,
  force = false,
): Promise<StartResolution> {
  const state = histGetDiscoveryState(db, addr.id, chain);
  if (state?.start_ts != null) return { state: 'active', startTs: state.start_ts };
  const inactiveKey = `history:inactive:${addr.id}:${chain}`;
  const checkedAt = Number(histGetMeta(db, inactiveKey) ?? 0);
  if (!force && nowSec() - checkedAt < INACTIVE_RECHECK) return { state: 'inactive' };
  let s: Awaited<ReturnType<typeof computeStart>>;
  try {
    s = await computeStart(db, chain, addr.id, addr.address, rpc, log, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    const msg = 'Could not determine first activity, retrying';
    log.warn(`backfill ${chain}: ${addr.address}: ${msg}`, { error: String(e).slice(0, 300) });
    histSetProgress(db, addr.id, chain, 0, 0);
    histSetMeta(db, errorKey(addr.id, chain), msg);
    return { state: 'error', msg };
  }
  if (!s) {
    log.info(`backfill ${chain}: ${addr.address} has no on-chain activity, skipping`);
    histSetProgress(db, addr.id, chain, 0, 0);
    histSetMeta(db, inactiveKey, String(nowSec()));
    return { state: 'inactive' };
  }
  log.info(`backfill ${chain}: ${addr.address} starts ${isoDay(s.startTs)} (block ${s.startBlock})`, { sources: s.sources });
  histSetStart(db, addr.id, chain, s.startBlock, s.startTs);
  histSetMeta(db, errorKey(addr.id, chain), '');
  return { state: 'active', startTs: s.startTs };
}

/** Wallet tokens valued per block (everything except native and Aave position tokens). */
export function walletTokensFor(db: Db, addressId: number, chain: HistoryChain, reserves: ReserveCache): HistAddressToken[] {
  return histListAddressTokens(db, addressId, chain).filter(
    (t) =>
      t.address !== NATIVE_TOKEN &&
      t.decimals != null &&
      !(t.kind && AAVE_KINDS.has(t.kind)) &&
      t.kind !== 'native' &&
      // an aToken / debt token of a (possibly delisted) reserve is valued as an Aave position only
      !reserves.isPositionToken(t.address),
  );
}

export async function blockForTs(db: Db, chain: HistoryChain, ts: number, signal?: AbortSignal): Promise<number> {
  const cached = histGetBlock(db, chain, ts);
  if (cached != null) return cached;
  const j = await fetchJson<{ height?: number; timestamp?: number }>(`https://coins.llama.fi/block/${chain}/${ts}`, { signal, retries: 5 });
  if (!j?.height) throw new Error(`no block for ${chain} at ${ts}`);
  histPutBlock(db, chain, ts, j.height);
  return j.height;
}

interface DayContext {
  prices: Map<string, Map<number, number>>;
  ensureKey: (key: string) => Promise<void>;
  failedPriceKeys: Set<string>;
}

type Slot =
  | { t: 'native'; a: number }
  | { t: 'wallet'; a: number; token: HistAddressToken }
  | { t: 'aave'; a: number; r: ReserveTokens; side: 'supply' | 'vdebt' | 'sdebt' }
  | { t: 'acct'; a: number; market: string };

/** One address of a point read: the address and its wallet tokens. */
export interface PointAddr {
  addr: HistAddress;
  walletTokens: HistAddressToken[];
}

/** Chain context of a point read (RPC pool + Aave reserve cache). */
export interface PointChain {
  chain: HistoryChain;
  rpc: RpcPool;
  reserves: ReserveCache;
}

export interface PointSpec {
  kind: 'daily' | 'hourly';
  /** Snapshot ts the slices are written to. */
  ts: number;
  /** State is read at the first block at/after this ts. */
  blockTs: number;
  /** For log lines. */
  label: string;
  /**
   * USD price of a key at this point; null = no price (valued at $0). Throw to fail the point
   * (e.g. the ETH price or a key whose download failed: the point is retried next run).
   */
  price: (key: string) => number | null;
  /** Record keys without a price as missing (daily_flags). */
  flagMissing: boolean;
  /** Called after historical Aave reserves were registered (all reserve price keys). */
  onNewReserves?: (keys: string[]) => Promise<void>;
  /** Called before valuation with the price keys of every non-zero balance. */
  beforeValue?: (keys: string[]) => Promise<void>;
}

async function processDay(
  db: Db,
  plan: ChainPlan,
  day: number,
  addrs: AddrPlan[],
  ctx: DayContext,
  log: HistoryLogger,
  signal?: AbortSignal,
): Promise<void> {
  const { prices, ensureKey, failedPriceKeys } = ctx;
  await processPoint(
    db,
    plan,
    addrs,
    {
      kind: 'daily',
      ts: day,
      blockTs: day + DAY,
      label: isoDay(day),
      price: (key) => {
        const p = priceForDayEnd(prices.get(key), day);
        if (p != null) return p;
        if (key === ETH_KEY || failedPriceKeys.has(key)) throw new Error(`no ${isoDay(day)} price for ${key} (price download failed, retry next run)`);
        return null;
      },
      flagMissing: true,
      onNewReserves: async (keys) => {
        for (const k of keys) await ensureKey(k);
      },
    },
    log,
    signal,
  );
}

/**
 * Read the state of `addrs` on one chain at the first block at/after `spec.blockTs` (ONE multicall:
 * native + wallet tokens + every Aave reserve token + getUserAccountData), value it with
 * `spec.price` and write the slices into the `spec.kind` snapshot at `spec.ts`.
 * Returns false when nothing was written (hourly: every slice was already present).
 */
export async function processPoint(
  db: Db,
  plan: PointChain,
  addrs: PointAddr[],
  spec: PointSpec,
  log: HistoryLogger,
  signal?: AbortSignal,
  attempt = 0,
): Promise<boolean> {
  const { chain, rpc, reserves } = plan;
  const block = await blockForTs(db, chain, spec.blockTs, signal);
  const markets = marketsForChain(chain);

  const preMulticall = block < MULTICALL3_DEPLOY_BLOCK[chain];
  const calls: HistCall[] = preMulticall ? [] : markets.map((m) => call(m.pool, encReservesList()));
  const nHead = calls.length;
  const slots: Slot[] = [];
  const allReserves = reserves.all();
  addrs.forEach((ap, a) => {
    const user = ap.addr.address;
    calls.push(nativeBalanceCall(user));
    slots.push({ t: 'native', a });
    for (const t of ap.walletTokens) {
      if (t.first_block != null && t.first_block > block) continue;
      calls.push(call(t.address, encBalanceOf(user)));
      slots.push({ t: 'wallet', a, token: t });
    }
    // Aave v3 postdates Multicall3 on both chains: skip its slots on pre-Multicall3 blocks
    // (they would otherwise become hundreds of single eth_calls per day).
    for (const r of preMulticall ? [] : allReserves) {
      calls.push(call(r.aToken, encBalanceOf(user)));
      slots.push({ t: 'aave', a, r, side: 'supply' });
      calls.push(call(r.vDebt, encBalanceOf(user)));
      slots.push({ t: 'aave', a, r, side: 'vdebt' });
      if (r.sDebt) {
        calls.push(call(r.sDebt, encBalanceOf(user)));
        slots.push({ t: 'aave', a, r, side: 'sdebt' });
      }
    }
    for (const m of preMulticall ? [] : markets) {
      calls.push(call(m.pool, encAccountData(user)));
      slots.push({ t: 'acct', a, market: m.key });
    }
  });

  const res = await multicallAt(rpc, chain, block, calls, signal);

  // Reserves that existed at this block but are unknown (e.g. delisted since): register and redo.
  if (attempt === 0 && !preMulticall) {
    const missing: { market: (typeof markets)[number]; asset: string }[] = [];
    markets.forEach((m, i) => {
      for (const asset of decodeReservesList(res[i]) ?? []) if (!reserves.has(m.key, asset)) missing.push({ market: m, asset });
    });
    if (missing.length) {
      log.info(`backfill ${chain} ${spec.label}: ${missing.length} historical Aave reserves not seen before, registering`);
      await reserves.addReserves(missing, block, signal);
      await spec.onNewReserves?.(reserves.all().map((r) => r.priceKey));
      return processPoint(db, plan, addrs, spec, log, signal, 1);
    }
  }

  // Reserves listed by each market at this block. A failed sub-call for a listed reserve (or for
  // getUserAccountData of a live market) is an RPC-side failure (e.g. gas starvation inside a big
  // aggregate3), not a zero balance: fail the point so it is retried instead of losing the position.
  const listed = new Map<string, Set<string>>();
  if (!preMulticall) markets.forEach((m, i) => {
    const l = decodeReservesList(res[i]);
    if (l) listed.set(m.key, new Set(l));
  });

  if (spec.beforeValue) {
    const keys = new Set<string>();
    slots.forEach((s, i) => {
      if (s.t === 'acct' || decodeUint(res[nHead + i]) === 0n) return;
      if (s.t === 'native') keys.add(ETH_KEY);
      else if (s.t === 'wallet') {
        if (!s.token.spam) keys.add(tokenPriceKey(chain, s.token));
      } else keys.add(s.r.priceKey);
    });
    await spec.beforeValue([...keys]);
  }

  const entries: HistAddressDay[] = addrs.map((ap) => ({ addressId: ap.addr.id, balances: [], positions: [], aave: [], missingPriceKeys: [] }));
  /** Price at this point; no price = valued at $0 (and, for daily points, the slice is flagged). */
  const price = (key: string, a: number): number => {
    const p = spec.price(key);
    if (p != null) return p;
    if (spec.flagMissing) {
      const miss = entries[a].missingPriceKeys!;
      if (!miss.includes(key)) miss.push(key);
    }
    return 0;
  };
  const walletUsd = new Array<number>(addrs.length).fill(0);
  const aaveUsd = new Array<number>(addrs.length).fill(0);
  const aaveAny = new Array<boolean>(addrs.length).fill(false);

  const push = (a: number, row: HistBalanceRow) => entries[a].balances.push(row);

  slots.forEach((s, i) => {
    const r = res[nHead + i];
    if (s.t === 'acct') {
      if (listed.has(s.market) && !r?.success) throw new Error(`getUserAccountData failed on ${s.market} at block ${block}`);
      const acct = decodeAccountData(r);
      if (acct && (acct.collateralUsd > 0 || acct.debtUsd > 0)) entries[s.a].aave.push({ market: s.market, ...acct });
      return;
    }
    if (s.t === 'aave' && !r?.success && listed.get(s.r.market)?.has(s.r.asset)) {
      throw new Error(`${s.side} balanceOf failed for ${s.r.market} reserve ${s.r.asset} at block ${block}`);
    }
    const raw = decodeUint(r);
    if (raw === 0n) return;
    if (s.t === 'native') {
      const amount = Number(formatUnits(raw, 18));
      const usd = amount * price(ETH_KEY, s.a);
      walletUsd[s.a] += usd;
      push(s.a, { token: NATIVE_TOKEN, amountRaw: raw.toString(), amount, usd, protocol: 'wallet', side: 'wallet' });
    } else if (s.t === 'wallet') {
      const amount = Number(formatUnits(raw, s.token.decimals!));
      const p = s.token.spam ? 0 : price(tokenPriceKey(chain, s.token), s.a);
      const usd = amount * p;
      walletUsd[s.a] += usd;
      push(s.a, { token: s.token.address, amountRaw: raw.toString(), amount, usd, protocol: 'wallet', side: 'wallet' });
    } else {
      const amount = Number(formatUnits(raw, s.r.decimals));
      const p = price(s.r.priceKey, s.a);
      const sign = s.side === 'supply' ? 1 : -1; // debt is negated here; prices are always the underlying's (positive)
      const usd = sign * amount * p;
      aaveUsd[s.a] += usd;
      aaveAny[s.a] = true;
      const token = s.side === 'supply' ? s.r.aToken : s.side === 'vdebt' ? s.r.vDebt : s.r.sDebt!;
      push(s.a, { token, amountRaw: raw.toString(), amount, usd, protocol: 'aave-v3', side: s.side === 'supply' ? 'supply' : 'borrow' });
    }
  });

  entries.forEach((e, a) => {
    e.positions.push({ protocol: 'wallet', usd: walletUsd[a] }); // always written: zero points chart as zero and mark the point done
    if (aaveAny[a]) e.positions.push({ protocol: 'aave-v3', usd: aaveUsd[a] });
  });
  const marketKeys = markets.map((m) => m.key);
  if (spec.kind === 'daily') {
    histWriteDailyChainDay(db, chain, spec.ts, marketKeys, entries);
    return true;
  }
  return histWriteHourlyChainHour(db, chain, spec.ts, marketKeys, entries) > 0;
}
