// Determine where history starts for an (address, chain), and (as a fallback when discovery has
// not run yet) which ERC20 tokens the address has touched.
// Start = earliest of: first Transfer log (in or out), Safe creation, first native activity.
import { getAddress, type Hex } from 'viem';
import { histAddAddressToken, histInsertTokenIfMissing, histListAddressTokens } from '../db/repos-history';
import { fetchTokenMeta } from './aave';
import { fetchJson } from './http';
import { isSpam } from '../scan/spam';
import { fetchCurrentPrices, priceOf } from '../scan/valuation';
import { canonicalPriceKey } from './price-keys';
import { logsRpc, toHex, type RpcPool } from './rpc';
import type { Db, HistoryChain, HistoryLogger } from './types';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface StartInfo {
  startBlock: number;
  startTs: number;
  sources: string[];
}

interface Log {
  address: string;
  blockNumber: Hex;
  topics: Hex[];
}

function padTopic(addr: string): Hex {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as Hex;
}

async function blockTs(rpc: RpcPool, block: number, signal?: AbortSignal): Promise<number> {
  const b = await rpc.request<{ timestamp: Hex }>('eth_getBlockByNumber', [toHex(block), false], signal);
  return Number(BigInt(b.timestamp));
}

/** Full-range Transfer logs (in and out). Returns null when no endpoint could answer. */
async function transferLogs(chain: HistoryChain, address: string, archive: RpcPool, log: HistoryLogger, signal?: AbortSignal): Promise<Log[] | null> {
  const t = padTopic(address);
  const filters = [
    { fromBlock: '0x0', toBlock: 'latest', topics: [TRANSFER, t] },
    { fromBlock: '0x0', toBlock: 'latest', topics: [TRANSFER, null, t] },
  ];
  for (const rpc of [logsRpc(chain, log), archive]) {
    try {
      const out: Log[] = [];
      for (const f of filters) out.push(...(await rpc.request<Log[]>('eth_getLogs', [f], signal, 3)));
      return out;
    } catch (e) {
      log.debug?.(`full-range getLogs failed on ${chain}`, { error: String(e).slice(0, 200) });
    }
  }
  return null;
}

async function safeCreation(chain: HistoryChain, address: string, signal?: AbortSignal): Promise<number | null> {
  const host = chain === 'ethereum' ? 'safe-transaction-mainnet.safe.global' : 'safe-transaction-arbitrum.safe.global';
  try {
    const j = await fetchJson<{ created?: string }>(`https://${host}/api/v1/safes/${getAddress(address)}/creation/`, {
      signal,
      retries: 2,
      nullOn: [404, 422],
    });
    if (j?.created) return Math.floor(Date.parse(j.created) / 1000);
  } catch {
    /* not a Safe or service down */
  }
  return null;
}

/** Ethereum only: Blockscout etherscan-compatible API, earliest tx and token transfer. */
async function blockscoutFirst(address: string, signal?: AbortSignal): Promise<{ block: number; ts: number } | null> {
  let best: { block: number; ts: number } | null = null;
  for (const action of ['txlist', 'tokentx']) {
    try {
      const j = await fetchJson<{ result?: { blockNumber: string; timeStamp: string }[] }>(
        `https://eth.blockscout.com/api?module=account&action=${action}&address=${address}&sort=asc&page=1&offset=1`,
        { signal, retries: 3 },
      );
      const r = Array.isArray(j?.result) ? j!.result[0] : undefined;
      if (r) {
        const c = { block: Number(r.blockNumber), ts: Number(r.timeStamp) };
        if (!best || c.block < best.block) best = c;
      }
    } catch {
      /* ignore */
    }
  }
  return best;
}

/**
 * Binary search the first block where nonce > 0 or balance > 0 (monotone enough for EOAs and contracts).
 * A probe that no endpoint can answer (pruned / pre-Nitro state) counts as "not active", so the
 * search moves to newer blocks instead of failing the whole start computation.
 */
async function firstNativeActivity(rpc: RpcPool, address: string, latest: number, log: HistoryLogger, signal?: AbortSignal): Promise<number | null> {
  let probeErrors = 0;
  const active = async (b: number) => {
    const tag = toHex(b);
    try {
      const [n, bal] = await Promise.all([
        rpc.request<Hex>('eth_getTransactionCount', [address, tag], signal),
        rpc.request<Hex>('eth_getBalance', [address, tag], signal),
      ]);
      return BigInt(n) > 0n || BigInt(bal) > 0n;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (b === latest) throw e;
      probeErrors++;
      return false;
    }
  };
  if (!(await active(latest))) return null;
  let lo = 0;
  let hi = latest;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await active(mid)) hi = mid;
    else lo = mid;
  }
  if (probeErrors) log.warn(`native activity search: ${probeErrors} archive probe(s) failed, start may be later than the real first activity`, { address });
  return hi;
}

export async function computeStart(
  db: Db,
  chain: HistoryChain,
  addressId: number,
  address: string,
  rpc: RpcPool,
  log: HistoryLogger,
  signal?: AbortSignal,
): Promise<StartInfo | null> {
  const latestHex = await rpc.request<Hex>('eth_blockNumber', [], signal);
  const latest = Number(BigInt(latestHex));
  const candidates: { block: number | null; ts: number | null; source: string }[] = [];

  // 1. Transfer logs (also registers touched tokens when discovery has not done so yet).
  const logs = await transferLogs(chain, address, rpc, log, signal);
  if (logs && logs.length) {
    const erc20 = logs.filter((l) => l.topics.length === 3);
    const firstBlock = Math.min(...logs.map((l) => Number(BigInt(l.blockNumber))));
    candidates.push({ block: firstBlock, ts: null, source: 'transfer-logs' });
    await registerLogTokens(db, chain, addressId, erc20, rpc, latest, log, signal);
  }

  // 2. Safe creation (only meaningful if the address has code).
  const code = await rpc.request<Hex>('eth_getCode', [address, 'latest'], signal).catch(() => '0x' as Hex);
  if (code && code !== '0x') {
    const ts = await safeCreation(chain, address, signal);
    if (ts) candidates.push({ block: null, ts, source: 'safe-creation' });
  }

  // 3. First native activity.
  if (chain === 'ethereum') {
    const f = await blockscoutFirst(address, signal);
    if (f) candidates.push({ block: f.block, ts: f.ts, source: 'blockscout' });
  }
  if (!candidates.length || chain !== 'ethereum') {
    const b = await firstNativeActivity(rpc, address, latest, log, signal).catch((e) => {
      log.warn(`native activity search failed on ${chain}`, { error: String(e).slice(0, 200) });
      return null;
    });
    if (b != null) candidates.push({ block: b, ts: null, source: 'native' });
  }

  if (!candidates.length) return null;
  for (const c of candidates) if (c.ts == null && c.block != null) c.ts = await blockTs(rpc, c.block, signal);
  candidates.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.block == null ? 1 : 0) - (b.block == null ? 1 : 0));
  const first = candidates[0];
  // a Safe creation time has no block: borrow the earliest known block
  const knownBlocks = candidates.map((c) => c.block).filter((b): b is number => b != null);
  return { startBlock: first.block ?? (knownBlocks.length ? Math.min(...knownBlocks) : 0), startTs: first.ts!, sources: candidates.map((c) => `${c.source}@${c.ts}`) };
}

async function registerLogTokens(
  db: Db,
  chain: HistoryChain,
  addressId: number,
  logs: Log[],
  rpc: RpcPool,
  latest: number,
  log: HistoryLogger,
  signal?: AbortSignal,
): Promise<void> {
  const firstByToken = new Map<string, number>();
  for (const l of logs) {
    const t = l.address.toLowerCase();
    const b = Number(BigInt(l.blockNumber));
    if (!firstByToken.has(t) || b < firstByToken.get(t)!) firstByToken.set(t, b);
  }
  const known = new Set(histListAddressTokens(db, addressId, chain).map((t) => t.address));
  const fresh = [...firstByToken.keys()].filter((t) => !known.has(t));
  if (!fresh.length) return;
  const meta = await fetchTokenMeta(rpc, chain, latest, fresh, signal);
  // Same spam verdict as discovery (name patterns + "DefiLlama has no current price"), so a token
  // registered here first is not shown (or valued in history) when discovery would hide it.
  const keyOf = new Map(fresh.map((t) => [t, canonicalPriceKey(chain, t)] as const));
  const lookup = await fetchCurrentPrices([...new Set(keyOf.values())], undefined, signal);
  let added = 0;
  for (const t of fresh) {
    const m = meta.get(t);
    if (!m || m.decimals == null) continue; // not an ERC20 (or self-destructed)
    const key = keyOf.get(t)!;
    const priced = lookup.answered.has(key) ? priceOf(lookup, key) !== undefined : undefined;
    const spam = isSpam({ symbol: m.symbol, name: m.name, priced, trusted: key.startsWith('coingecko:') });
    histInsertTokenIfMissing(db, {
      chain,
      address: t,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      kind: 'erc20',
      underlying: null,
      market: null,
      price_key: key,
      spam: spam ? 1 : 0,
    });
    histAddAddressToken(db, addressId, chain, t, firstByToken.get(t)!);
    added++;
  }
  if (added) log.info(`history: registered ${added} tokens from transfer logs on ${chain}`, { addressId });
}
