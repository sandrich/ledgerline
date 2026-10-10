// Job types, payload parsing and dispatch for the worker.
// Job rows live in the `jobs` table; status 'pending' -> 'running' -> 'done' | 'failed'.
// Canonical types (aliases accepted so other writers, e.g. POST /api/sync, can use either):
//   snapshot      (live, live-snapshot)       live snapshot of all addresses
//   discovery     (discover)                  token discovery; payload { addressId? | address? | walletId? | scope? }
//   sync          (refresh)                   discovery (scoped) + live snapshot of all addresses
//   backfill                                  daily history; payload { addressId?, chains?, redo? }
//   hourly-backfill (hourly_backfill)         last 7 days of hourly history; payload { addressId?, chains? }
//   price-history (prices, price_history)     daily price series + FX
//   rollup        (retention)                 rollup / retention
//   ledger        (transactions)              transactions ledger, incremental; payload { addressId? | walletId? | scope?, chains? }
import { runBackfill } from '../history/backfill';
import { runHourlyBackfill } from '../history/hourly';
import { syncPriceHistory } from '../history/prices';
import { runRollup } from '../history/rollup';
import { runLedger } from '../ledger/ingest';
import type { Db } from '../history/types';
import {
  scanFindAddressId,
  scanJobProgress,
  scanWalletAddressIds,
  type JobRow,
  type ScanChain,
} from '../db/repos-scan';
import { runDiscovery } from './discover';
import { runLiveSnapshot } from './live';
import { errMsg, type Logger } from './log';
import { runSmartWalletDiscovery } from './smart-wallets';

export type JobType = 'snapshot' | 'discovery' | 'sync' | 'backfill' | 'hourly-backfill' | 'price-history' | 'rollup' | 'ledger';

const ALIASES: Record<string, JobType> = {
  snapshot: 'snapshot',
  live: 'snapshot',
  'live-snapshot': 'snapshot',
  live_snapshot: 'snapshot',
  discovery: 'discovery',
  discover: 'discovery',
  sync: 'sync',
  refresh: 'sync',
  backfill: 'backfill',
  'hourly-backfill': 'hourly-backfill',
  hourly_backfill: 'hourly-backfill',
  'price-history': 'price-history',
  price_history: 'price-history',
  prices: 'price-history',
  rollup: 'rollup',
  retention: 'rollup',
  ledger: 'ledger',
  transactions: 'ledger',
};

export function normalizeJobType(t: string): JobType | null {
  return ALIASES[t.toLowerCase()] ?? null;
}

/** Raw type strings (with aliases) that belong to each worker lane. */
export const SCAN_LANE_TYPES = Object.keys(ALIASES).filter((k) => ['snapshot', 'discovery', 'sync'].includes(ALIASES[k]));
export const HISTORY_LANE_TYPES = Object.keys(ALIASES).filter((k) => ['backfill', 'hourly-backfill', 'price-history', 'rollup', 'ledger'].includes(ALIASES[k]));

interface ScopePayload {
  addressId?: number | string;
  address_id?: number | string;
  address?: string;
  addressIds?: (number | string)[];
  walletId?: number | string;
  wallet_id?: number | string;
  scope?: string;
  chains?: string[];
  chain?: string;
  redo?: boolean;
}

function asObj(p: unknown): ScopePayload {
  return p && typeof p === 'object' && !Array.isArray(p) ? (p as ScopePayload) : {};
}

/** Resolve a payload scope to address ids; undefined means "all addresses". */
export function resolveAddressIds(db: Db, payload: unknown): number[] | undefined {
  const p = asObj(payload);
  const ids = new Set<number>();
  const addId = (v: unknown) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) ids.add(n);
  };
  addId(p.addressId);
  addId(p.address_id);
  for (const v of p.addressIds ?? []) addId(v);
  if (typeof p.address === 'string') {
    const id = scanFindAddressId(db, p.address);
    if (id != null) ids.add(id);
  }
  const wallet = p.walletId ?? p.wallet_id;
  if (wallet != null) for (const id of scanWalletAddressIds(db, Number(wallet))) ids.add(id);
  if (typeof p.scope === 'string' && p.scope !== 'all') {
    const [kind, val] = [p.scope.slice(0, p.scope.indexOf(':')), p.scope.slice(p.scope.indexOf(':') + 1)];
    if (kind === 'wallet') for (const id of scanWalletAddressIds(db, Number(val))) ids.add(id);
    else if (kind === 'address') {
      const n = Number(val);
      const id = Number.isInteger(n) && n > 0 && !val.startsWith('0x') ? n : scanFindAddressId(db, val);
      if (id != null) ids.add(id);
    }
  }
  const scoped = p.addressId != null || p.address_id != null || p.addressIds != null || p.address != null || wallet != null || (p.scope && p.scope !== 'all');
  return scoped ? [...ids] : undefined;
}

function chainsOf(payload: unknown): ScanChain[] | undefined {
  const p = asObj(payload);
  const raw = p.chains ?? (p.chain ? [p.chain] : undefined);
  if (!raw) return undefined;
  const c = raw.filter((x): x is ScanChain => x === 'ethereum' || x === 'arbitrum');
  return c.length ? c : undefined;
}

export interface JobContext {
  db: Db;
  log: Logger;
  signal: AbortSignal;
  job: JobRow;
}

/** Execute one claimed job. Throws on failure (the caller marks the row failed). */
export async function dispatchJob(ctx: JobContext): Promise<unknown> {
  const { db, log, signal, job } = ctx;
  const type = normalizeJobType(job.type);
  const payload = job.payload;
  switch (type) {
    case 'snapshot': {
      const r = await runLiveSnapshot({ db, log, signal });
      return { ts: r.ts, totalUsd: r.totalUsd };
    }
    case 'discovery': {
      const ids = resolveAddressIds(db, payload);
      if (ids && !ids.length) return { skipped: 'no matching addresses' };
      const r = await runDiscovery({ db, log, signal, addressIds: ids, chains: chainsOf(payload) });
      // LEDGER: smart wallets (Safes, DSProxies) owned by tracked EOAs, once per day per EOA
      let smartWallets: number | string = 0;
      try {
        smartWallets = (await runSmartWalletDiscovery({ db, log, signal, addressIds: ids })).newSuggestions;
      } catch (e) {
        if (signal.aborted) throw e;
        smartWallets = errMsg(e);
        log.warn('smart wallet discovery failed', { error: smartWallets });
      }
      return { pairs: r.results.length, backfillJobs: r.backfillJobs, smartWallets };
    }
    case 'sync': {
      const ids = resolveAddressIds(db, payload);
      if (!ids || ids.length) {
        scanJobProgress(db, job.id, 0, 2);
        await runDiscovery({ db, log, signal, addressIds: ids, chains: chainsOf(payload) });
      }
      scanJobProgress(db, job.id, 1, 2);
      // Always snapshot ALL addresses: a partial live snapshot would read as a drop in totals.
      const r = await runLiveSnapshot({ db, log, signal });
      scanJobProgress(db, job.id, 2, 2);
      return { ts: r.ts, totalUsd: r.totalUsd };
    }
    case 'backfill': {
      const ids = resolveAddressIds(db, payload);
      const p = asObj(payload);
      const targets: (number | undefined)[] = ids === undefined ? [undefined] : ids;
      let last = 0;
      for (const addressId of targets) {
        await runBackfill({
          db,
          log,
          signal,
          addressId,
          chains: chainsOf(payload),
          redo: p.redo === true,
          onProgress: (done, total) => {
            // Throttle DB writes to about one per second.
            const t = Date.now();
            if (t - last < 1000 && done < total) return;
            last = t;
            scanJobProgress(db, job.id, done, total);
          },
        });
      }
      return { addresses: targets.length };
    }
    case 'hourly-backfill': {
      const ids = resolveAddressIds(db, payload);
      if (ids && !ids.length) return { skipped: 'no matching addresses' };
      let last = 0;
      // all addresses in ONE run: each (chain, hour) multicall batches every address that needs it
      const r = await runHourlyBackfill({
        db,
        log,
        signal,
        addressIds: ids,
        chains: chainsOf(payload),
        onProgress: (done, total) => {
          const t = Date.now();
          if (t - last < 1000 && done < total) return;
          last = t;
          scanJobProgress(db, job.id, done, total);
        },
      });
      return { slicesTodo: r.slicesTodo, slicesWritten: r.slicesWritten, chains: r.chains };
    }
    case 'price-history': {
      const r = await syncPriceHistory({ db, log, signal });
      return r;
    }
    case 'rollup': {
      const r = await runRollup({ db, log, signal });
      return r;
    }
    case 'ledger': {
      const ids = resolveAddressIds(db, payload);
      if (ids && !ids.length) return { skipped: 'no matching addresses' };
      let last = 0;
      const r = await runLedger({
        db,
        log,
        signal,
        addressIds: ids,
        chains: chainsOf(payload),
        onProgress: (done, total) => {
          const t = Date.now();
          if (t - last < 1000 && done < total) return;
          last = t;
          scanJobProgress(db, job.id, done, total);
        },
      });
      return { pairs: r.pairs.length, newTransfers: r.pairs.reduce((s, p) => s + p.newTransfers, 0), calls: { ...r.stats } };
    }
    default:
      throw new Error(`unknown job type '${job.type}'`);
  }
}
