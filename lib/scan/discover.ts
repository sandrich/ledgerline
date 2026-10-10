// Token discovery.
// Per (address, chain), union of:
//   1. ERC20 Transfer logs with the address in topic1 (out) or topic2 (in). First run: full range in
//      one call (tenderly gateway answers it keylessly), falling back to the archive pool, then to
//      Blockscout token-transfers (eth) / chunked ranges with a per-run budget. Afterwards incremental
//      from discovery_state.last_block.
//   2. Ethereum only: Blockscout token-balances.
//   3. Contracts (Safes): Safe transaction service balances (checksummed address).
//   4. Always: every Aave v3 reserve's aToken / variable / stable debt token (via ReserveCache, which
//      writes the same token rows the history backfill uses).
// New tokens get metadata via multicall (symbol/name/decimals), a canonical price key and a spam flag.
// The first completed run for an (address, chain) enqueues its hourly (last 7 days) and then its daily
// history backfill, so both plan with the full token set. A new non-spam token found later sets a durable redo marker
// (from the day the token first moved) and enqueues a backfill that rewrites those days.
import { getAddress, type Hex } from 'viem';
import {
  NATIVE,
  scanAddAddressToken,
  scanEnqueueJob,
  scanEnsureNativeToken,
  scanGetLastBlock,
  scanGetTokens,
  scanInsertToken,
  scanKnownAddressTokens,
  scanListAddresses,
  scanSetIsContract,
  scanSetLastBlock,
  scanSetTokenLogo,
  scanSetTokenSpam,
  type ScanAddress,
  type ScanChain,
  SCAN_CHAINS,
} from '../db/repos-scan';
import { histRequestRedo } from '../db/repos-history';
import { ReserveCache, fetchTokenMeta } from '../history/aave';
import { fetchJson } from '../history/http';
import { canonicalPriceKey } from '../history/price-keys';
import { archiveRpc, logsRpc, toHex, type RpcPool } from '../history/rpc';
import { DAY, dayStart, throwIfAborted, type Db } from '../history/types';
import { errMsg, type Logger } from './log';
import { HEAD_LAG, headBlock, latestRpc, logsLatestRpc } from './rpc-latest';
import { isSpam, nameLooksSpam } from './spam';
import { fetchCurrentPrices, priceOf } from './valuation';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface RunDiscoveryOptions {
  db: Db;
  log: Logger;
  signal?: AbortSignal;
  /** Restrict to these address ids (default: all). */
  addressIds?: number[];
  chains?: ScanChain[];
  /** Max eth_getLogs requests per (address, chain) when falling back to chunked ranges. */
  chunkBudget?: number;
}

export interface DiscoveryAddressResult {
  addressId: number;
  chain: ScanChain;
  firstRun: boolean;
  logs: number;
  candidates: number;
  newTokens: string[];
  lastBlock: number | null;
  sources: string[];
  /** Earliest Transfer block per token seen in this run (null when the source had no block). */
  firstBlocks: Map<string, number | null>;
  error?: string;
}

export interface DiscoveryResult {
  results: DiscoveryAddressResult[];
  backfillJobs: number[];
  durationMs: number;
}

interface RawLog {
  address: string;
  blockNumber: Hex;
  topics: Hex[];
}

interface Candidate {
  token: string;
  firstBlock: number | null;
  logo?: string | null;
  symbol?: string | null;
  name?: string | null;
  decimals?: number | null;
  flaggedBySource?: boolean;
}

const padTopic = (addr: string): Hex => `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex;

// ---------------------------------------------------------------------------------------------
// Transfer logs

async function logsBothDirections(rpc: RpcPool, address: string, from: number, to: number, signal?: AbortSignal, attempts = 3): Promise<RawLog[]> {
  const t = padTopic(address);
  const range = { fromBlock: toHex(from), toBlock: toHex(to) };
  const out = await rpc.request<RawLog[]>('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, t] }], signal, attempts);
  const inn = await rpc.request<RawLog[]>('eth_getLogs', [{ ...range, topics: [TRANSFER_TOPIC, null, t] }], signal, attempts);
  return [...out, ...inn];
}

/** Chunked eth_getLogs with adaptive range size. Returns logs and the last block fully covered. */
async function logsChunked(
  rpc: RpcPool,
  address: string,
  from: number,
  to: number,
  budget: number,
  log: Logger,
  signal?: AbortSignal,
): Promise<{ logs: RawLog[]; reached: number }> {
  const logs: RawLog[] = [];
  let size = 10_000;
  let cur = from;
  let reached = from - 1;
  let requests = 0;
  while (cur <= to && requests < budget) {
    throwIfAborted(signal);
    const end = Math.min(to, cur + size - 1);
    try {
      requests += 2;
      logs.push(...(await logsBothDirections(rpc, address, cur, end, signal, 2)));
      reached = end;
      cur = end + 1;
      if (size < 100_000) size = Math.min(100_000, size * 2);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (size <= 10) throw e;
      size = Math.max(10, Math.floor(size / 5));
      log.debug(`getLogs range too large or failed, shrinking to ${size}`, { error: errMsg(e) });
    }
  }
  return { logs, reached };
}

interface BlockscoutTransferPage {
  items?: { token?: { address_hash?: string; address?: string; type?: string }; block_number?: number }[];
  next_page_params?: Record<string, string | number> | null;
}

/** Ethereum fallback when full-range logs fail: Blockscout token-transfers (paginated, newest first). */
async function blockscoutTransferTokens(address: string, log: Logger, signal?: AbortSignal, maxPages = 60): Promise<Candidate[] | null> {
  const first = new Map<string, number>();
  let params = '';
  try {
    for (let page = 0; page < maxPages; page++) {
      const j = await fetchJson<BlockscoutTransferPage>(`https://eth.blockscout.com/api/v2/addresses/${address}/token-transfers?type=ERC-20${params}`, {
        signal,
        retries: 4,
        nullOn: [404, 422],
      });
      if (!j) break;
      for (const it of j.items ?? []) {
        const a = (it.token?.address_hash ?? it.token?.address ?? '').toLowerCase();
        if (!a) continue;
        const b = Number(it.block_number ?? NaN);
        const prev = first.get(a);
        if (Number.isFinite(b)) first.set(a, prev == null ? b : Math.min(prev, b));
        else if (prev == null) first.set(a, Number.MAX_SAFE_INTEGER);
      }
      if (!j.next_page_params) return [...first].map(([token, b]) => ({ token, firstBlock: b === Number.MAX_SAFE_INTEGER ? null : b }));
      params = `&${new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)]))}`;
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn('blockscout token-transfers failed', { error: errMsg(e) });
    return null;
  }
  log.warn(`blockscout token-transfers: stopped after ${maxPages} pages, token set may be incomplete`);
  return [...first].map(([token, b]) => ({ token, firstBlock: b === Number.MAX_SAFE_INTEGER ? null : b }));
}

function logsToCandidates(logs: RawLog[]): Candidate[] {
  const first = new Map<string, number>();
  for (const l of logs) {
    if (!l.topics || l.topics.length !== 3) continue; // ERC20 only (ERC721 Transfer has 4 topics)
    const a = l.address.toLowerCase();
    const b = Number(BigInt(l.blockNumber));
    const prev = first.get(a);
    first.set(a, prev == null ? b : Math.min(prev, b));
  }
  return [...first].map(([token, firstBlock]) => ({ token, firstBlock }));
}

// ---------------------------------------------------------------------------------------------
// Indexer sources

interface BlockscoutTokenBalance {
  token?: {
    address_hash?: string;
    address?: string;
    symbol?: string | null;
    name?: string | null;
    decimals?: string | null;
    type?: string;
    icon_url?: string | null;
    reputation?: string | null;
    exchange_rate?: string | null;
  };
  value?: string;
}

async function blockscoutBalances(address: string, log: Logger, signal?: AbortSignal): Promise<Candidate[]> {
  try {
    const j = await fetchJson<BlockscoutTokenBalance[]>(`https://eth.blockscout.com/api/v2/addresses/${address}/token-balances`, {
      signal,
      retries: 3,
      nullOn: [404, 422],
    });
    if (!Array.isArray(j)) return [];
    return j
      .filter((x) => x.token && (x.token.type ?? 'ERC-20') === 'ERC-20')
      .map((x) => {
        const t = x.token!;
        const dec = t.decimals != null ? Number(t.decimals) : null;
        return {
          token: (t.address_hash ?? t.address ?? '').toLowerCase(),
          firstBlock: null,
          logo: t.icon_url ?? null,
          symbol: t.symbol ?? null,
          name: t.name ?? null,
          decimals: dec != null && Number.isFinite(dec) ? dec : null,
          flaggedBySource: !!t.reputation && t.reputation !== 'ok',
        };
      })
      .filter((c) => c.token.startsWith('0x') && c.token.length === 42);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn('blockscout token-balances failed', { error: errMsg(e) });
    return [];
  }
}

interface SafeBalance {
  tokenAddress: string | null;
  token: { name?: string; symbol?: string; decimals?: number; logoUri?: string } | null;
  balance: string;
}

const SAFE_HOST: Record<ScanChain, string> = {
  ethereum: 'safe-transaction-mainnet.safe.global',
  arbitrum: 'safe-transaction-arbitrum.safe.global',
};

async function safeBalances(chain: ScanChain, address: string, log: Logger, signal?: AbortSignal): Promise<Candidate[] | null> {
  try {
    const j = await fetchJson<SafeBalance[]>(
      `https://${SAFE_HOST[chain]}/api/v1/safes/${getAddress(address)}/balances/?trusted=false&exclude_spam=true`,
      { signal, retries: 3, nullOn: [404, 422] },
    );
    if (!Array.isArray(j)) return null; // not a Safe
    return j
      .filter((b) => b.tokenAddress)
      .map((b) => ({
        token: b.tokenAddress!.toLowerCase(),
        firstBlock: null,
        logo: b.token?.logoUri ?? null,
        symbol: b.token?.symbol ?? null,
        name: b.token?.name ?? null,
        decimals: b.token?.decimals ?? null,
      }));
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`safe balances failed on ${chain}`, { error: errMsg(e) });
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Main

export async function runDiscovery(opts: RunDiscoveryOptions): Promise<DiscoveryResult> {
  const t0 = Date.now();
  const { db, log, signal } = opts;
  const chains = opts.chains ?? SCAN_CHAINS;
  const addresses = scanListAddresses(db, opts.addressIds);
  const result: DiscoveryResult = { results: [], backfillJobs: [], durationMs: 0 };
  if (!addresses.length) {
    result.durationMs = Date.now() - t0;
    return result;
  }

  await Promise.all(
    chains.map(async (chain) => {
      const addrs = addresses.filter((a) => a.chains.includes(chain));
      if (!addrs.length) return;
      const rpc = latestRpc(chain, log);
      let head: number;
      try {
        head = (await headBlock(rpc, signal)) - HEAD_LAG[chain];
      } catch (e) {
        if (signal?.aborted) throw e;
        log.error(`discovery ${chain}: cannot read head block`, { error: errMsg(e) });
        return;
      }
      scanEnsureNativeToken(db, chain);
      // Aave reserve tokens first, so log-discovered aTokens / debt tokens already carry their kind.
      try {
        const reserves = new ReserveCache(db, chain, rpc, log);
        const added = await reserves.refreshAt(head, signal);
        if (added) log.info(`discovery ${chain}: registered ${added} Aave reserves`);
      } catch (e) {
        if (signal?.aborted) throw e;
        log.warn(`discovery ${chain}: Aave reserve refresh failed`, { error: errMsg(e) });
      }
      for (const a of addrs) {
        throwIfAborted(signal);
        try {
          const r = await discoverOne(db, chain, a, head, rpc, opts);
          result.results.push(r);
          const tokens = scanGetTokens(db, chain, r.newTokens);
          const real = r.newTokens.filter((t) => !tokens.get(t)?.spam);
          if (real.length) {
            // Days already written (e.g. by a scheduled backfill that ran before this discovery) lack
            // these tokens: mark them for rewrite from the day the earliest new token first moved.
            const fromDay = await redoStartDay(rpc, r.firstBlocks, real, signal);
            histRequestRedo(db, a.id, chain, fromDay);
          }
          if (r.firstRun) {
            // Last 7 days at hourly resolution first (short and cheap): the history lane claims the
            // lowest job id, so this runs before the long daily backfill enqueued just below.
            const hid = scanEnqueueJob(db, 'hourly-backfill', { addressId: a.id, chains: [chain] });
            result.backfillJobs.push(hid);
            // transactions ledger for the new (address, chain); runs on the history lane
            scanEnqueueJob(db, 'ledger', { addressId: a.id, chains: [chain] });
          }
          if (r.firstRun || real.length) {
            const id = scanEnqueueJob(db, 'backfill', { addressId: a.id, chains: [chain] });
            result.backfillJobs.push(id);
            log.info(
              r.firstRun
                ? `discovery ${chain}: first run for ${a.address} done, enqueued history backfill job ${id}`
                : `discovery ${chain}: ${a.address} has ${real.length} new token(s), enqueued backfill job ${id}`,
              real.length ? { tokens: real } : undefined,
            );
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          log.error(`discovery ${chain}: ${a.address} failed`, { error: errMsg(e) });
          result.results.push({
            addressId: a.id,
            chain,
            firstRun: false,
            logs: 0,
            candidates: 0,
            newTokens: [],
            lastBlock: null,
            sources: [],
            firstBlocks: new Map(),
            error: errMsg(e),
          });
        }
      }
    }),
  );
  result.durationMs = Date.now() - t0;
  log.info(`discovery finished in ${(result.durationMs / 1000).toFixed(1)}s`, {
    pairs: result.results.length,
    newTokens: result.results.reduce((s, r) => s + r.newTokens.length, 0),
  });
  return result;
}

async function discoverOne(db: Db, chain: ScanChain, a: ScanAddress, head: number, rpc: RpcPool, opts: RunDiscoveryOptions): Promise<DiscoveryAddressResult> {
  const { log, signal } = opts;
  const lastBlock = scanGetLastBlock(db, a.id, chain);
  const firstRun = lastBlock == null;
  const res: DiscoveryAddressResult = { addressId: a.id, chain, firstRun, logs: 0, candidates: 0, newTokens: [], lastBlock, sources: [], firstBlocks: new Map() };
  const candidates: Candidate[] = [];

  // Contract? (Safe / smart account / EIP-7702 delegated EOA all have code)
  const code = await rpc.request<Hex>('eth_getCode', [a.address, toHex(head)], signal).catch(() => null);
  const isContract = !!code && code !== '0x';
  if (code != null) scanSetIsContract(db, a.id, chain, isContract);

  // 1. Transfer logs.
  let reached: number | null = null;
  const from = (lastBlock ?? -1) + 1;
  if (from <= head) {
    const bigRange = head - from > 200_000;
    let logs: RawLog[] | null = null;
    if (bigRange) {
      for (const pool of [logsRpc(chain, log), archiveRpc(chain, log)]) {
        try {
          logs = await logsBothDirections(pool, a.address, from, head, signal);
          reached = head;
          res.sources.push('logs-full');
          break;
        } catch (e) {
          if (signal?.aborted) throw e;
          log.debug(`discovery ${chain}: full-range getLogs failed`, { error: errMsg(e) });
        }
      }
      if (!logs && chain === 'ethereum' && firstRun) {
        const bs = await blockscoutTransferTokens(a.address, log, signal);
        if (bs) {
          candidates.push(...bs);
          reached = head;
          res.sources.push('blockscout-transfers');
          logs = [];
        }
      }
    }
    if (!logs) {
      const out = await logsChunked(logsLatestRpc(chain, log), a.address, from, head, opts.chunkBudget ?? 300, log, signal);
      logs = out.logs;
      reached = out.reached >= from ? out.reached : null;
      res.sources.push('logs-chunked');
      if (reached != null && reached < head) log.info(`discovery ${chain}: ${a.address} logs scanned to ${reached} of ${head}, will continue next run`);
    }
    res.logs = logs.length;
    candidates.push(...logsToCandidates(logs));
  } else {
    reached = lastBlock;
  }

  // 2. Blockscout balances (ethereum only; arbitrum.blockscout.com is Cloudflare blocked).
  if (chain === 'ethereum') {
    const bs = await blockscoutBalances(a.address, log, signal);
    if (bs.length) res.sources.push('blockscout-balances');
    candidates.push(...bs);
  }

  // 3. Safe balances for contracts.
  if (isContract) {
    const sb = await safeBalances(chain, a.address, log, signal);
    if (sb) {
      res.sources.push('safe');
      candidates.push(...sb);
    }
  }

  // Merge candidates per token.
  const merged = new Map<string, Candidate>();
  for (const c of candidates) {
    if (!c.token || c.token === NATIVE) continue;
    const prev = merged.get(c.token);
    if (!prev) {
      merged.set(c.token, { ...c });
      continue;
    }
    prev.firstBlock = prev.firstBlock == null ? c.firstBlock : c.firstBlock == null ? prev.firstBlock : Math.min(prev.firstBlock, c.firstBlock);
    prev.logo ??= c.logo;
    prev.symbol ??= c.symbol;
    prev.name ??= c.name;
    prev.decimals ??= c.decimals;
    prev.flaggedBySource = prev.flaggedBySource || c.flaggedBySource;
  }
  res.candidates = merged.size;
  for (const [t, c] of merged) res.firstBlocks.set(t, c.firstBlock);

  // Register unknown tokens (metadata + price key + spam flag).
  const tokenAddrs = [...merged.keys()];
  const known = scanGetTokens(db, chain, tokenAddrs);
  const unknown = tokenAddrs.filter((t) => !known.has(t));
  if (unknown.length) await registerTokens(db, chain, unknown, merged, head, rpc, log, signal);
  // Tokens registered elsewhere (e.g. by the history backfill's own Transfer scan, which can run
  // first) are re-judged with discovery's signals; this only ever hides a token, never unhides one.
  for (const [t, k] of known) {
    if (k.spam || k.kind !== 'erc20' || k.price_key?.startsWith('coingecko:')) continue;
    const h = merged.get(t);
    if (h?.flaggedBySource || nameLooksSpam(k.symbol, k.name)) {
      scanSetTokenSpam(db, chain, t, true);
      log.info(`discovery ${chain}: token ${t} ${k.symbol ?? '?'} reclassified as spam`);
    }
  }
  for (const [t, c] of merged) if (c.logo && known.has(t) && !known.get(t)!.logo) scanSetTokenLogo(db, chain, t, c.logo);

  // Link to the address.
  const before = scanKnownAddressTokens(db, a.id, chain);
  db.transaction(() => {
    for (const [t, c] of merged) {
      if (scanAddAddressToken(db, a.id, chain, t, c.firstBlock) && !before.has(t)) res.newTokens.push(t);
    }
    if (reached != null) scanSetLastBlock(db, a.id, chain, reached);
  })();
  res.lastBlock = reached;
  log.info(`discovery ${chain}: ${a.address} ${res.logs} logs, ${res.candidates} tokens, ${res.newTokens.length} new`, {
    sources: res.sources,
    lastBlock: reached,
    firstRun,
  });
  return res;
}

/** UTC day from which history must be rewritten for newly found tokens (0 = from the start). */
async function redoStartDay(rpc: RpcPool, firstBlocks: Map<string, number | null>, tokens: string[], signal?: AbortSignal): Promise<number> {
  const blocks = tokens.map((t) => firstBlocks.get(t));
  if (blocks.some((b) => b == null)) return 0; // a source without block info (balances API): redo everything
  const first = Math.min(...(blocks as number[]));
  try {
    const b = await rpc.request<{ timestamp: Hex }>('eth_getBlockByNumber', [toHex(first), false], signal);
    return dayStart(Number(BigInt(b.timestamp))) - DAY; // one day of slack for the end-of-day convention
  } catch (e) {
    if (signal?.aborted) throw e;
    return 0;
  }
}

async function registerTokens(
  db: Db,
  chain: ScanChain,
  tokens: string[],
  hints: Map<string, Candidate>,
  head: number,
  rpc: RpcPool,
  log: Logger,
  signal?: AbortSignal,
): Promise<void> {
  let meta = new Map<string, { symbol: string | null; name: string | null; decimals: number | null }>();
  try {
    meta = await fetchTokenMeta(rpc, chain, head, tokens, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    log.warn(`discovery ${chain}: token metadata multicall failed`, { error: errMsg(e) });
  }
  const keys = new Map<string, string>();
  for (const t of tokens) keys.set(t, canonicalPriceKey(chain, t));
  const lookup = await fetchCurrentPrices([...new Set(keys.values())], log, signal);
  for (const t of tokens) {
    const h = hints.get(t);
    const m = meta.get(t);
    const symbol = m?.symbol ?? h?.symbol ?? null;
    const name = m?.name ?? h?.name ?? null;
    const decimals = m?.decimals ?? h?.decimals ?? null;
    const key = keys.get(t)!;
    const trusted = key.startsWith('coingecko:');
    const priced = lookup.answered.has(key) ? priceOf(lookup, key) !== undefined : undefined;
    const spam = decimals == null || isSpam({ symbol, name, priced, flaggedBySource: h?.flaggedBySource, trusted });
    scanInsertToken(db, {
      chain,
      address: t,
      symbol,
      name,
      decimals,
      kind: 'erc20',
      underlying: null,
      market: null,
      price_key: key,
      logo: h?.logo ?? null,
      spam: spam ? 1 : 0,
    });
    log.debug(`discovery ${chain}: token ${t} ${symbol ?? '?'} ${spam ? '(spam)' : ''}`);
  }
}
