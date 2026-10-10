// Raw data sources for the transactions ledger.
// - ERC20 Transfer logs (address in topic1 = out, topic2 = in) and Approval logs (owner in topic1):
//   full range on the tenderly gateway (answers keylessly and adds a blockTimestamp field), then the
//   archive pool, then chunked ranges on the incremental logs pool with a per-run request budget.
//   Same order as token discovery (lib/scan/discover.ts).
// - Native ETH: alchemy_getAssetTransfers (fromAddress and toAddress, paginated with pageKey).
//   Verified 2026-10: Ethereum accepts categories external + internal, Arbitrum rejects 'internal'
//   ("The 'internal' category is not supported for this network"), so Arbitrum gets external only
//   and native ETH paid out by contracts (internal calls) is not visible there.
import { RpcPool, archiveRpc, logsRpc, toHex } from '../history/rpc';
import { throwIfAborted, type HistoryChain } from '../history/types';
import { logsLatestRpc } from '../scan/rpc-latest';
import { errMsg, type Logger } from '../scan/log';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  /** non standard (tenderly, some other providers), hex unix seconds */
  blockTimestamp?: string;
}

/** Simple per-run call counters, reported by the backfill script. */
export class CallStats {
  rpc = 0;
  logs = 0;
  alchemy = 0;
  receipts = 0;
  blocks = 0;
  add(other: CallStats): void {
    this.rpc += other.rpc;
    this.logs += other.logs;
    this.alchemy += other.alchemy;
    this.receipts += other.receipts;
    this.blocks += other.blocks;
  }
}

const padTopic = (addr: string): string => `0x000000000000000000000000${addr.slice(2).toLowerCase()}`;

async function getLogs(rpc: RpcPool, filter: Record<string, unknown>, stats: CallStats, signal?: AbortSignal, attempts = 3): Promise<RawLog[]> {
  stats.rpc++;
  stats.logs++;
  return rpc.request<RawLog[]>('eth_getLogs', [filter], signal, attempts);
}

/** Transfer out + Transfer in + Approval (owner) logs for one range. ERC20 only (3 topics). */
async function logsForRange(rpc: RpcPool, address: string, from: number, to: number, stats: CallStats, signal?: AbortSignal, attempts = 3): Promise<RawLog[]> {
  const t = padTopic(address);
  const range = { fromBlock: toHex(from), toBlock: toHex(to) };
  const out = await getLogs(rpc, { ...range, topics: [TRANSFER_TOPIC, t] }, stats, signal, attempts);
  const inn = await getLogs(rpc, { ...range, topics: [TRANSFER_TOPIC, null, t] }, stats, signal, attempts);
  const appr = await getLogs(rpc, { ...range, topics: [APPROVAL_TOPIC, t] }, stats, signal, attempts);
  return [...out, ...inn, ...appr].filter((l) => l.topics?.length === 3);
}

export interface LogsResult {
  logs: RawLog[];
  /** last block fully covered (from - 1 when nothing was covered) */
  reached: number;
  source: string;
}

/**
 * Logs for [from, head]. Large ranges try one full-range request per pool first; otherwise (or on
 * failure) adaptive chunks with a request budget, returning how far it got so the caller can resume.
 */
export async function fetchLogs(
  chain: HistoryChain,
  address: string,
  from: number,
  head: number,
  log: Logger,
  stats: CallStats,
  signal?: AbortSignal,
  budget = 300,
  /** first block worth scanning when falling back to chunks (e.g. the first activity found by discovery) */
  chunkFrom?: number,
): Promise<LogsResult> {
  if (from > head) return { logs: [], reached: head, source: 'none' };
  if (head - from > 200_000) {
    for (const [name, pool] of [
      ['logs-full', logsRpc(chain, log)],
      ['archive-full', archiveRpc(chain, log)],
    ] as const) {
      try {
        const logs = await logsForRange(pool, address, from, head, stats, signal);
        return { logs, reached: head, source: name };
      } catch (e) {
        if (signal?.aborted) throw e;
        log.debug(`ledger ${chain}: ${name} getLogs failed`, { error: errMsg(e) });
      }
    }
  }
  const rpc = logsLatestRpc(chain, log);
  const logs: RawLog[] = [];
  let size = 10_000;
  let cur = Math.max(from, chunkFrom ?? from);
  let reached = cur - 1;
  let requests = 0;
  while (cur <= head && requests < budget) {
    throwIfAborted(signal);
    const end = Math.min(head, cur + size - 1);
    try {
      requests += 3;
      logs.push(...(await logsForRange(rpc, address, cur, end, stats, signal, 2)));
      reached = end;
      cur = end + 1;
      if (size < 100_000) size = Math.min(100_000, size * 2);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (size <= 10) throw e;
      size = Math.max(10, Math.floor(size / 5));
      log.debug(`ledger ${chain}: getLogs range failed, shrinking to ${size}`, { error: errMsg(e) });
    }
  }
  return { logs, reached, source: 'logs-chunked' };
}

// ---------------------------------------------------------------------------------------------
// Alchemy native transfers

export interface AlchemyTransfer {
  blockNum: string;
  uniqueId: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null };
  metadata?: { blockTimestamp?: string };
}

/** The env RPC URL when it is an Alchemy endpoint (alchemy_* methods), else null. */
export function alchemyUrl(chain: HistoryChain): string | null {
  const env = process.env;
  const cands = chain === 'ethereum' ? [env.ETH_RPC_URL, env.ETH_ARCHIVE_RPC_URL] : [env.ARB_RPC_URL, env.ARB_ARCHIVE_RPC_URL];
  return cands.find((u) => !!u && /alchemy\.com/i.test(u)) ?? null;
}

/** Categories per chain; 'internal' is dropped for a chain once Alchemy rejects it. */
const categories: Record<HistoryChain, string[]> = { ethereum: ['external', 'internal'], arbitrum: ['external'] };

let alchemyId = 1;
async function alchemyCall<T>(url: string, params: unknown, stats: CallStats, signal?: AbortSignal): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    throwIfAborted(signal);
    stats.alchemy++;
    try {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), 30_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: alchemyId++, method: 'alchemy_getAssetTransfers', params: [params] }),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const body = JSON.parse(text) as { result?: T; error?: { code?: number; message?: string } };
        if (body.error) {
          const err = new Error(`alchemy error ${body.error.code ?? ''}: ${body.error.message ?? ''}`);
          if (body.error.code === -32602 || /not supported/i.test(body.error.message ?? '')) (err as Error & { fatal?: boolean }).fatal = true;
          throw err;
        }
        if (!body.result) throw new Error('alchemy: empty result');
        return body.result;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      if ((e as { fatal?: boolean }).fatal) throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function assetTransfersDir(
  url: string,
  chain: HistoryChain,
  dir: 'fromAddress' | 'toAddress',
  address: string,
  from: number,
  to: number,
  log: Logger,
  stats: CallStats,
  signal?: AbortSignal,
): Promise<AlchemyTransfer[]> {
  const out: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < 200; page++) {
    const params = {
      fromBlock: toHex(from),
      toBlock: toHex(to),
      category: categories[chain],
      [dir]: address,
      withMetadata: true,
      excludeZeroValue: false,
      maxCount: '0x3e8',
      order: 'asc',
      ...(pageKey ? { pageKey } : {}),
    };
    let r: { transfers: AlchemyTransfer[]; pageKey?: string };
    try {
      r = await alchemyCall(url, params, stats, signal);
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal && categories[chain].includes('internal')) {
        log.info(`ledger ${chain}: alchemy rejects category 'internal', using 'external' only`, { error: errMsg(e) });
        categories[chain] = ['external'];
        page--;
        continue;
      }
      throw e;
    }
    out.push(...r.transfers);
    if (!r.pageKey) return out;
    pageKey = r.pageKey;
  }
  log.warn(`ledger ${chain}: alchemy pagination stopped after 200 pages for ${address}`);
  return out;
}

/** Native ETH transfers (external + internal where supported) from and to the address in [from, to]. */
export async function fetchNative(
  chain: HistoryChain,
  address: string,
  from: number,
  to: number,
  log: Logger,
  stats: CallStats,
  signal?: AbortSignal,
): Promise<AlchemyTransfer[] | null> {
  const url = alchemyUrl(chain);
  if (!url) return null;
  if (from > to) return [];
  const outs = await assetTransfersDir(url, chain, 'fromAddress', address, from, to, log, stats, signal);
  const ins = await assetTransfersDir(url, chain, 'toAddress', address, from, to, log, stats, signal);
  return [...outs, ...ins];
}
