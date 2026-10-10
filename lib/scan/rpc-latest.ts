// Latest-state JSON-RPC pools. Reuses the rotating, throttled RpcPool from
// lib/history/rpc.ts; only the endpoint lists differ (env URL first, then keyless public nodes).
import { RpcPool } from '../history/rpc';
import type { HistoryChain } from '../history/types';
import type { Logger } from './log';

const KEYED_MS = 100; // env endpoint (e.g. Alchemy free tier): ~10 rps
const PUBLIC_MS = 400; // ~2.5 rps per public endpoint

const pools = new Map<HistoryChain, RpcPool>();

export function latestRpc(chain: HistoryChain, log?: Logger): RpcPool {
  let p = pools.get(chain);
  if (p) {
    if (log) p.setLogger(log);
    return p;
  }
  const env = process.env;
  const urls =
    chain === 'ethereum'
      ? [
          { url: env.ETH_RPC_URL ?? '', minIntervalMs: KEYED_MS },
          { url: 'https://ethereum-rpc.publicnode.com', minIntervalMs: PUBLIC_MS },
          { url: 'https://rpc.mevblocker.io', minIntervalMs: PUBLIC_MS },
          { url: 'https://eth.drpc.org', minIntervalMs: PUBLIC_MS },
        ]
      : [
          { url: env.ARB_RPC_URL ?? '', minIntervalMs: KEYED_MS },
          { url: 'https://arb1.arbitrum.io/rpc', minIntervalMs: PUBLIC_MS },
          { url: 'https://arbitrum-one-rpc.publicnode.com', minIntervalMs: PUBLIC_MS },
          { url: 'https://arbitrum-one.public.blastapi.io', minIntervalMs: PUBLIC_MS },
        ];
  p = new RpcPool(chain, urls, log);
  pools.set(chain, p);
  return p;
}

const logPools = new Map<HistoryChain, RpcPool>();

/**
 * Pool for incremental eth_getLogs. Kept separate so range-limit rejections (free-tier Alchemy:
 * tiny ranges; blastapi: 10 blocks; publicnode: "archive requires token") do not disable endpoints
 * of the snapshot pool. Ordered by research results: arb1 (30k blocks), mevblocker (100k), drpc
 * (10k), tenderly gateways; the env endpoint goes last (a paid key would work, free tier does not).
 */
export function logsLatestRpc(chain: HistoryChain, log?: Logger): RpcPool {
  let p = logPools.get(chain);
  if (p) {
    if (log) p.setLogger(log);
    return p;
  }
  const env = process.env;
  const urls =
    chain === 'ethereum'
      ? [
          { url: 'https://rpc.mevblocker.io', minIntervalMs: PUBLIC_MS },
          { url: 'https://eth.drpc.org', minIntervalMs: PUBLIC_MS },
          { url: 'https://mainnet.gateway.tenderly.co', minIntervalMs: 600 },
          { url: env.ETH_RPC_URL ?? '', minIntervalMs: KEYED_MS },
        ]
      : [
          { url: 'https://arb1.arbitrum.io/rpc', minIntervalMs: PUBLIC_MS },
          { url: 'https://arbitrum.gateway.tenderly.co', minIntervalMs: 600 },
          { url: env.ARB_RPC_URL ?? '', minIntervalMs: KEYED_MS },
        ];
  p = new RpcPool(chain, urls, log);
  logPools.set(chain, p);
  return p;
}

/**
 * Blocks to stay behind the head for "latest" reads, so a load-balanced public node that is a
 * few blocks behind the one that answered eth_blockNumber can still serve the call.
 */
export const HEAD_LAG: Record<HistoryChain, number> = { ethereum: 1, arbitrum: 20 };

export async function headBlock(rpc: RpcPool, signal?: AbortSignal): Promise<number> {
  const hex = await rpc.request<string>('eth_blockNumber', [], signal);
  return Number(BigInt(hex));
}
