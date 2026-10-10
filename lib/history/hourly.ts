// Hourly history backfill for the most recent completed UTC hours (default 168 = 7 days), so the
// 24h / 7d charts of a freshly added address are not a straight line until live data accumulates.
//
// Convention: an hourly snapshot at ts = UTC hour start h holds the state at the first block at/after
// h (block via DefiLlama, cached in `blocks`), valued with the hourly price at h. (Daily snapshots
// differ: ts = day start, end-of-day state.) Per (chain, hour) ONE multicall batches every address
// that still needs that hour: native + wallet tokens + every Aave reserve token + getUserAccountData
// (same token set as the daily backfill, see processPoint).
//
// Only COMPLETED hours are filled (the current hour is covered by live snapshots), and an hour is
// skipped for an (address, chain) when it already has an hourly slice (backfilled earlier, or rolled
// up from live data) or any live slice inside it. So live data always wins, re-runs are idempotent
// and an interrupted run resumes where it stopped. Newest hours first.
import {
  histCoveredHours,
  histGetDiscoveryState,
  histGetMeta,
  histListAddresses,
  histLoadDailyPrices,
  histLoadPrices,
  type HistAddress,
} from '../db/repos-history';
import { ReserveCache } from './aave';
import { processPoint, resolveStart, walletTokensFor, type PointAddr, type PointChain } from './backfill';
import { ETH_KEY } from './price-keys';
import { syncHourlyPrices, syncPriceHistory } from './prices';
import { archiveRpc } from './rpc';
import {
  DAY,
  HISTORY_CHAINS,
  dayStart,
  mapLimit,
  nowSec,
  throwIfAborted,
  type Db,
  type HistoryChain,
  type HistoryJobOptions,
  type HistoryLogger,
} from './types';

export const HOUR = 3600;
const INACTIVE_RECHECK = 6 * 3600; // same as the daily backfill

export interface RunHourlyBackfillOptions extends HistoryJobOptions {
  /** Restrict to these addresses (default: all). */
  addressIds?: number[];
  chains?: HistoryChain[];
  /** Completed hours to cover, newest first (default env HOURLY_BACKFILL_HOURS or 168). */
  hours?: number;
  /** Hours in flight per chain (default 4; the RPC pool throttles per endpoint anyway). */
  concurrency?: number;
  now?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface HourlyChainResult {
  addresses: number;
  hours: number;
  processed: number;
  failed: number;
  skippedInactive: number;
}

export interface HourlyBackfillResult {
  chains: Partial<Record<HistoryChain, HourlyChainResult>>;
  /** (address, chain, hour) slices still missing before the run. */
  slicesTodo: number;
  slicesWritten: number;
  priceRequests: number;
  durationMs: number;
}

export function hourlyBackfillHours(): number {
  const v = Number(process.env.HOURLY_BACKFILL_HOURS);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 24 * 30) : 168;
}

/** [first, last] UTC hour starts of the window: the `hours` completed hours before the current one. */
export function hourlyWindow(now: number, hours: number): { first: number; last: number } {
  const last = Math.floor(now / HOUR) * HOUR - HOUR;
  return { first: last - (hours - 1) * HOUR, last };
}

function knownInactive(db: Db, addressId: number, chain: HistoryChain): boolean {
  const st = histGetDiscoveryState(db, addressId, chain);
  if (st?.start_ts != null) return false;
  const checkedAt = Number(histGetMeta(db, `history:inactive:${addressId}:${chain}`) ?? 0);
  return nowSec() - checkedAt < INACTIVE_RECHECK;
}

/** Hours of the window an (address, chain) still needs (after its first activity, when known). */
function missingHours(db: Db, addressId: number, chain: HistoryChain, first: number, last: number, startTs: number | null): number[] {
  const covered = histCoveredHours(db, addressId, chain, first, last);
  const from = startTs != null ? Math.max(first, Math.floor(startTs / HOUR) * HOUR) : first;
  const out: number[] = [];
  for (let h = last; h >= from; h -= HOUR) if (!covered.has(h)) out.push(h);
  return out;
}

/**
 * Addresses with at least `minMissing` uncovered hours in the window on some chain (no RPC; used by
 * the worker to decide whether to enqueue the job). Known-inactive pairs are ignored.
 */
export function addressesNeedingHourly(db: Db, opts: { now?: number; hours?: number; minMissing?: number } = {}): number[] {
  const { first, last } = hourlyWindow(opts.now ?? nowSec(), opts.hours ?? hourlyBackfillHours());
  const out: number[] = [];
  for (const a of histListAddresses(db)) {
    for (const chain of a.chains) {
      if (knownInactive(db, a.id, chain)) continue;
      const start = histGetDiscoveryState(db, a.id, chain)?.start_ts ?? null;
      if (missingHours(db, a.id, chain, first, last, start).length >= (opts.minMissing ?? 1)) {
        out.push(a.id);
        break;
      }
    }
  }
  return out;
}

/** Hourly / live / daily price lookups for the window, with lazy per-key downloads. */
class HourlyPrices {
  private hourly = new Map<string, Map<number, number>>();
  private live = new Map<string, { ts: number[]; usd: number[] }>();
  private daily = new Map<string, Map<number, number>>();
  private loading = new Map<string, Promise<void>>();
  readonly failed = new Set<string>();
  requests = 0;

  constructor(
    private db: Db,
    private log: HistoryLogger,
    private first: number,
    private last: number,
    private signal?: AbortSignal,
  ) {}

  ensure(keys: string[]): Promise<void> {
    const need = [...new Set(keys)].filter((k) => !this.loading.has(k));
    if (need.length) {
      const p = this.load(need);
      for (const k of need) this.loading.set(k, p);
    }
    return Promise.all(keys.map((k) => this.loading.get(k))).then(() => undefined);
  }

  private async load(keys: string[]): Promise<void> {
    const { db, log, signal, first, last } = this;
    // a few extra hours on both sides so the nearest-hour fallback works at the window edges
    const from = first - 3 * HOUR;
    const to = Math.min(last + 3 * HOUR, Math.floor(nowSec() / HOUR) * HOUR);
    const r = await syncHourlyPrices({ db, log, signal, keys, fromTs: from, toTs: to });
    this.requests += r.requests;
    const hourly = histLoadPrices(db, keys, 'hourly', from, to);
    // Keys DefiLlama has no hourly series for: make sure the daily series exists as a fallback.
    const noHourly = keys.filter((k) => !hourly.get(k)?.size && !r.failedKeys.includes(k));
    if (noHourly.length) {
      const d = await syncPriceHistory({ db, log, signal, keys: noHourly, fromTs: dayStart(first) - DAY, fx: false });
      this.requests += d.requests;
    }
    for (const k of r.failedKeys) this.failed.add(k);
    const live = histLoadPrices(db, keys, 'live', from - 2 * HOUR, to + 2 * HOUR);
    const daily = histLoadDailyPrices(db, keys, dayStart(first) - 8 * DAY);
    for (const k of keys) {
      this.hourly.set(k, hourly.get(k) ?? new Map());
      const lm = [...(live.get(k) ?? new Map<number, number>())].sort((a, b) => a[0] - b[0]);
      this.live.set(k, { ts: lm.map((x) => x[0]), usd: lm.map((x) => x[1]) });
      this.daily.set(k, daily.get(k) ?? new Map());
    }
  }

  /**
   * Price at hour h: the hourly point, else the nearest hourly point within 3h, else the nearest live
   * price within 2h, else the daily series (interpolated within the day, else up to 7 days back).
   * null = no price at all (valued at $0, not flagged). Throws when the ETH price or a key whose
   * download failed is missing, so the hour is retried on the next run.
   */
  price(key: string, h: number): number | null {
    const hm = this.hourly.get(key);
    const exact = hm?.get(h);
    if (exact != null) return exact;
    for (let d = 1; d <= 3 && hm; d++) {
      const v = hm.get(h - d * HOUR) ?? hm.get(h + d * HOUR);
      if (v != null) return v;
    }
    const lv = this.live.get(key);
    if (lv?.ts.length) {
      let lo = 0;
      let hi = lv.ts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lv.ts[mid] < h) lo = mid + 1;
        else hi = mid;
      }
      let best = -1;
      for (const i of [lo - 1, lo]) {
        if (i < 0 || i >= lv.ts.length) continue;
        if (Math.abs(lv.ts[i] - h) <= 2 * HOUR && (best < 0 || Math.abs(lv.ts[i] - h) < Math.abs(lv.ts[best] - h))) best = i;
      }
      if (best >= 0) return lv.usd[best];
    }
    const dm = this.daily.get(key);
    if (dm?.size) {
      const d0 = dayStart(h);
      const a = dm.get(d0);
      const b = dm.get(d0 + DAY);
      if (a != null && b != null) return a + ((b - a) * (h - d0)) / DAY;
      if (a != null || b != null) return (a ?? b)!;
      for (let d = d0 - DAY; d >= d0 - 7 * DAY; d -= DAY) {
        const v = dm.get(d);
        if (v != null) return v;
      }
    }
    if (key === ETH_KEY || this.failed.has(key)) throw new Error(`no hourly price for ${key} at ${new Date(h * 1000).toISOString()} (retry next run)`);
    return null;
  }
}

interface HourAddr extends PointAddr {
  todo: Set<number>;
}

export async function runHourlyBackfill(opts: RunHourlyBackfillOptions): Promise<HourlyBackfillResult> {
  const t0 = Date.now();
  const { db, log, signal } = opts;
  const now = opts.now ?? nowSec();
  const { first, last } = hourlyWindow(now, opts.hours ?? hourlyBackfillHours());
  const chains = opts.chains ?? HISTORY_CHAINS;
  const ids = opts.addressIds ? new Set(opts.addressIds) : null;
  const addresses = histListAddresses(db).filter((a) => !ids || ids.has(a.id));
  const result: HourlyBackfillResult = { chains: {}, slicesTodo: 0, slicesWritten: 0, priceRequests: 0, durationMs: 0 };
  const prices = new HourlyPrices(db, log, first, last, signal);

  // 1. Plan per chain without RPC: (address, chain) pairs with uncovered hours.
  const plans = chains.map((chain) => {
    const res: HourlyChainResult = { addresses: 0, hours: 0, processed: 0, failed: 0, skippedInactive: 0 };
    result.chains[chain] = res;
    const pending: HistAddress[] = [];
    for (const a of addresses.filter((x) => x.chains.includes(chain))) {
      if (knownInactive(db, a.id, chain)) {
        res.skippedInactive++;
        continue;
      }
      const start = histGetDiscoveryState(db, a.id, chain)?.start_ts ?? null;
      if (missingHours(db, a.id, chain, first, last, start).length) pending.push(a);
    }
    return { chain, res, pending };
  });
  if (plans.every((p) => !p.pending.length)) {
    result.durationMs = Date.now() - t0;
    log.info('hourly backfill: nothing to fill');
    return result;
  }

  // 2. Resolve first activity (shared with the daily backfill) and the hours each pair needs.
  const work = (
    await Promise.all(
      plans.map(async ({ chain, res, pending }) => {
        if (!pending.length) return null;
        const rpc = archiveRpc(chain, log);
        const reserves = new ReserveCache(db, chain, rpc, log);
        const ctx: PointChain = { chain, rpc, reserves };
        // Register current Aave reserves first (as the daily plan does), so aTokens / debt tokens
        // that were registered as plain ERC20s are excluded from the wallet tokens (no double count)
        // even when this runs before discovery finished for the address.
        const latest = Number(BigInt(await rpc.request<string>('eth_blockNumber', [], signal)));
        await reserves.refreshAt(latest, signal);
        const addrs: HourAddr[] = [];
        for (const a of pending) {
          throwIfAborted(signal);
          const st = await resolveStart(db, chain, a, rpc, log, signal);
          if (st.state === 'inactive') {
            res.skippedInactive++;
            continue;
          }
          // start unknown (lookup failed): fill the whole window, zero balances chart as zero
          const todo = missingHours(db, a.id, chain, first, last, st.state === 'active' ? st.startTs : null);
          if (todo.length) addrs.push({ addr: a, walletTokens: walletTokensFor(db, a.id, chain, reserves), todo: new Set(todo) });
        }
        res.addresses = addrs.length;
        return { chain, res, ctx, addrs };
      }),
    )
  ).filter((w): w is NonNullable<typeof w> => !!w && w.addrs.length > 0);

  const total = work.reduce((s, w) => s + w.addrs.reduce((x, a) => x + a.todo.size, 0), 0);
  result.slicesTodo = total;
  let done = 0;

  // 3. Walk hours per chain (chains in parallel, newest first).
  await Promise.all(
    work.map(async ({ chain, res, ctx, addrs }) => {
      const hours: number[] = [];
      for (let h = last; h >= first; h -= HOUR) if (addrs.some((a) => a.todo.has(h))) hours.push(h);
      res.hours = hours.length;
      log.info(`hourly backfill ${chain}: ${hours.length} hours to process, ${addrs.length} addresses`);
      let consecutiveFailures = 0;
      let stopped = false;
      await mapLimit(hours, opts.concurrency ?? 4, async (h) => {
        throwIfAborted(signal);
        if (consecutiveFailures >= 12) {
          stopped = true;
          return;
        }
        const todo = addrs.filter((a) => a.todo.has(h));
        try {
          const wrote = await processPoint(
            db,
            ctx,
            todo,
            {
              kind: 'hourly',
              ts: h,
              blockTs: h,
              label: new Date(h * 1000).toISOString().slice(0, 13) + 'h',
              price: (key) => prices.price(key, h),
              flagMissing: false,
              beforeValue: (keys) => prices.ensure(keys),
            },
            log,
            signal,
          );
          consecutiveFailures = 0;
          res.processed++;
          if (wrote) result.slicesWritten += todo.length;
          done += todo.length;
          opts.onProgress?.(done, total);
        } catch (e) {
          if (signal?.aborted) throw e;
          consecutiveFailures++;
          res.failed++;
          log.warn(`hourly backfill ${chain} ${new Date(h * 1000).toISOString()} failed`, { error: String(e).slice(0, 300) });
        }
      });
      if (stopped) {
        res.failed = hours.length - res.processed;
        log.error(`hourly backfill ${chain}: stopped after repeated failures, will resume next run`);
      }
    }),
  );
  result.priceRequests = prices.requests;
  result.durationMs = Date.now() - t0;
  log.info(`hourly backfill finished in ${(result.durationMs / 1000).toFixed(1)}s`, { ...result });
  const failed = Object.values(result.chains).reduce((n, c) => n + (c?.failed ?? 0), 0);
  if (failed > 0) throw new Error(`hourly backfill: ${failed} hour(s) could not be processed and will be retried on the next run`);
  return result;
}
