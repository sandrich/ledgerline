// Daily Aave v3 rate history: supply / variable borrow APY plus the reserve's liquidity index and
// variable borrow index, read with getReserveData on the Pool at the daily backfill blocks.
//
// Only reserves an address actually held are read, and only around the days it held them: for every
// daily snapshot day D with an Aave balance row of (market, asset) we need the state at D + 1 day
// (the block the daily snapshot was read at) and at D + 2 days (the next daily point, so the interest
// of the last held day can be computed even when the position was closed that day). Rows are
// immutable and keyed (market, asset, ts), so the job is resumable and a re-run only reads new days.
// One multicall per (chain, day) batches every reserve of that day: a few hundred calls in total.
//
// The indices make interest exact: a supplied balance a at index I grows to a x I' / I by index I'
// (same for debt with the variable borrow index), so interest between two points with an unchanged
// position is a x (I' / I - 1). See lib/queries/yield.ts. Table: aave_rates (migration 7, lib/db/migrate.ts).
import { decodeFunctionResult } from 'viem';
import { HIST_AAVE_MARKETS, call, encReserveData, poolAbi, rayToApy } from './aave';
import { blockForTs } from './backfill';
import { multicallAt, type HistResult } from './multicall';
import { archiveRpc } from './rpc';
import { DAY, dayStart, isoDay, nowSec, throwIfAborted, type Db, type HistoryChain, type HistoryJobOptions } from './types';

export interface AaveRateRow {
  chain: HistoryChain;
  market: string;
  asset: string;
  ts: number;
  block: number;
  supplyApy: number;
  borrowApy: number;
  /** ray / 1e27 */
  liquidityIndex: number;
  borrowIndex: number;
}

const RAY = 1e27;

export function decodeReserveRates(r: HistResult | undefined): Omit<AaveRateRow, 'chain' | 'market' | 'asset' | 'ts' | 'block'> | null {
  if (!r || !r.success || r.data.length < 66) return null;
  try {
    const d = decodeFunctionResult({ abi: poolAbi, functionName: 'getReserveData', data: r.data }) as {
      liquidityIndex: bigint;
      currentLiquidityRate: bigint;
      variableBorrowIndex: bigint;
      currentVariableBorrowRate: bigint;
    };
    const li = Number(BigInt(d.liquidityIndex)) / RAY;
    const bi = Number(BigInt(d.variableBorrowIndex)) / RAY;
    if (!(li > 0)) return null;
    return {
      supplyApy: rayToApy(BigInt(d.currentLiquidityRate)),
      borrowApy: rayToApy(BigInt(d.currentVariableBorrowRate)),
      liquidityIndex: li,
      borrowIndex: bi > 0 ? bi : 1,
    };
  } catch {
    return null;
  }
}

function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** (chain, market, asset, ts) tuples needed: day + 1 and day + 2 of every daily snapshot holding an Aave row. */
export function neededRatePoints(db: Db): Map<HistoryChain, Map<number, Set<string>>> {
  const out = new Map<HistoryChain, Map<number, Set<string>>>();
  const rows = db
    .prepare(
      `SELECT DISTINCT b.chain AS chain, t.market AS market, lower(t.underlying) AS asset, s.ts AS ts
       FROM balances b JOIN snapshots s ON s.id = b.snapshot_id
       JOIN tokens t ON t.chain = b.chain AND t.address = b.token
       WHERE s.kind = 'daily' AND b.side IN ('supply', 'borrow') AND t.market IS NOT NULL AND t.underlying IS NOT NULL
         AND b.amount IS NOT NULL AND b.amount <> 0`,
    )
    .all() as { chain: string; market: string; asset: string; ts: number }[];
  const today = dayStart(nowSec());
  const known = new Set(HIST_AAVE_MARKETS.map((m) => m.key));
  for (const r of rows) {
    if ((r.chain !== 'ethereum' && r.chain !== 'arbitrum') || !known.has(r.market)) continue;
    let byTs = out.get(r.chain);
    if (!byTs) out.set(r.chain, (byTs = new Map()));
    for (const ts of [r.ts + DAY, r.ts + 2 * DAY]) {
      if (ts > today) continue;
      let set = byTs.get(ts);
      if (!set) byTs.set(ts, (set = new Set()));
      set.add(`${r.market}|${r.asset}`);
    }
  }
  return out;
}

export interface SyncAaveRatesResult {
  days: number;
  calls: number;
  inserted: number;
  failed: number;
}

/**
 * Backfill daily rates and indices for every reserve held at some daily point (see file comment).
 * Already stored (market, asset, ts) rows are skipped; a failed day is simply retried next run.
 */
export async function syncAaveRateHistory(opts: HistoryJobOptions & { chains?: HistoryChain[] }): Promise<SyncAaveRatesResult> {
  const { db, log, signal } = opts;
  const res: SyncAaveRatesResult = { days: 0, calls: 0, inserted: 0, failed: 0 };
  if (!hasTable(db, 'aave_rates')) {
    log.warn('aave rates: table aave_rates missing (migration not applied yet)');
    return res;
  }
  const have = new Set(
    (db.prepare('SELECT market, asset, ts FROM aave_rates').all() as { market: string; asset: string; ts: number }[]).map(
      (r) => `${r.market}|${r.asset}|${r.ts}`,
    ),
  );
  const pools = new Map(HIST_AAVE_MARKETS.map((m) => [m.key, m]));
  const insert = db.prepare(
    `INSERT OR IGNORE INTO aave_rates (chain, market, asset, ts, block, supply_apy, borrow_apy, liquidity_index, borrow_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [chain, byTs] of neededRatePoints(db)) {
    if (opts.chains && !opts.chains.includes(chain)) continue;
    const rpc = archiveRpc(chain);
    // newest first: the recent past matters most for the yield view
    const days = [...byTs.keys()].sort((a, b) => b - a);
    for (const ts of days) {
      throwIfAborted(signal);
      const todo = [...byTs.get(ts)!].filter((k) => !have.has(`${k}|${ts}`));
      if (!todo.length) continue;
      res.days++;
      try {
        const block = await blockForTs(db, chain, ts, signal);
        const calls = todo.map((k) => {
          const [market, asset] = k.split('|');
          return call(pools.get(market)!.pool, encReserveData(asset));
        });
        res.calls += calls.length;
        const out = await multicallAt(rpc, chain, block, calls, signal);
        const rows: AaveRateRow[] = [];
        todo.forEach((k, i) => {
          const d = decodeReserveRates(out[i]);
          if (!d) return;
          const [market, asset] = k.split('|');
          rows.push({ chain, market, asset, ts, block, ...d });
        });
        db.transaction(() => {
          for (const r of rows) {
            res.inserted += Number(
              insert.run(r.chain, r.market, r.asset, r.ts, r.block, r.supplyApy, r.borrowApy, r.liquidityIndex, r.borrowIndex).changes,
            );
          }
        })();
      } catch (e) {
        if (signal?.aborted) throw e;
        res.failed++;
        log.warn(`aave rates ${chain} ${isoDay(ts)} failed`, { error: String(e).slice(0, 200) });
      }
    }
  }
  log.info(`aave rates: ${res.days} days, ${res.calls} reserve reads, ${res.inserted} new rows${res.failed ? `, ${res.failed} failed days` : ''}`);
  return res;
}

