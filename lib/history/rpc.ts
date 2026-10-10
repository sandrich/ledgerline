// Archive JSON-RPC pool used by the history backfill.
// Rotation on 429/5xx/401/403/timeouts and on archive / auth / capacity errors, per-endpoint throttle,
// temporary disabling of endpoints that keep failing. Single requests only (no JSON-RPC batching).
// NOTE: once lib/chain/rpc.ts lands this can be swapped for the shared pool; the surface used by
// lib/history is just `archiveRpc(chain).request(method, params)`.
import { sleep, throwIfAborted, type HistoryChain, type HistoryLogger } from './types';

interface Endpoint {
  url: string;
  label: string;
  minIntervalMs: number;
  nextSlot: number;
  consecutiveFailures: number;
  disabledUntil: number;
}

const ROTATE_PATTERNS = [
  'historical state',
  'pruned',
  'unknown state',
  'archive',
  'missing trie node',
  'not enabled',
  'unauthorized',
  'capacity',
  'rate limit',
  'too many requests',
  'exceeded',
  'header not found',
  'unknown block',
  'personal token',
  'internal error',
  'timeout',
  'unable to complete',
  'request failed',
];

export class RpcExecutionError extends Error {}

/** eth_getLogs rejected because of its block range / result size, not because the endpoint is down. */
export function isRangeLimitError(method: string, msg: string): boolean {
  if (method !== 'eth_getLogs') return false;
  return /block range|ranges over|range (is )?too (large|wide)|exceeds? (the )?(max|limit)|query returned more than|response size|too many (logs|results)|eth_getLogs (requests|with)|free (tier|plan)|limited to|10000 blocks|10,000/i.test(msg);
}

function redact(url: string): string {
  // host only: paths of keyed endpoints (e.g. /v2/<key>) must never reach logs
  try {
    return new URL(url).host;
  } catch {
    return 'rpc';
  }
}

function makeEndpoint(url: string, minIntervalMs: number): Endpoint {
  return { url, label: redact(url), minIntervalMs, nextSlot: 0, consecutiveFailures: 0, disabledUntil: 0 };
}

export class RpcPool {
  private endpoints: Endpoint[];
  private id = 1;
  constructor(
    public chain: HistoryChain,
    urls: { url: string; minIntervalMs: number }[],
    private log?: HistoryLogger,
  ) {
    const seen = new Set<string>();
    this.endpoints = [];
    for (const u of urls) {
      if (!u.url || seen.has(u.url)) continue;
      seen.add(u.url);
      this.endpoints.push(makeEndpoint(u.url, u.minIntervalMs));
    }
  }

  setLogger(log: HistoryLogger): void {
    this.log = log;
  }

  /** Pick the healthy endpoint whose next free slot is soonest (ties: configured order). */
  private pick(exclude: Set<Endpoint>): Endpoint {
    const now = Date.now();
    let candidates = this.endpoints.filter((e) => e.disabledUntil <= now && !exclude.has(e));
    if (candidates.length === 0) candidates = this.endpoints.filter((e) => !exclude.has(e));
    if (candidates.length === 0) candidates = this.endpoints;
    let best = candidates[0];
    for (const e of candidates) {
      if (Math.max(e.nextSlot, e.disabledUntil) < Math.max(best.nextSlot, best.disabledUntil)) best = e;
    }
    return best;
  }

  async request<T = unknown>(method: string, params: unknown[], signal?: AbortSignal, maxAttempts = 10): Promise<T> {
    let lastErr: unknown;
    const tried = new Set<Endpoint>();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted(signal);
      if (tried.size >= this.endpoints.length) tried.clear();
      const ep = this.pick(tried);
      const now = Date.now();
      const slot = Math.max(now, ep.nextSlot, ep.disabledUntil);
      ep.nextSlot = slot + ep.minIntervalMs;
      if (slot > now) await sleep(slot - now, signal);
      try {
        const result = await this.send<T>(ep, method, params, signal);
        ep.consecutiveFailures = 0;
        return result;
      } catch (e) {
        if (e instanceof RpcExecutionError) throw e;
        if (signal?.aborted) throw e;
        lastErr = e;
        tried.add(ep);
        const msg = e instanceof Error ? e.message : String(e);
        if (isRangeLimitError(method, msg)) {
          // The request is too big for this endpoint's plan (e.g. Alchemy free tier eth_getLogs range).
          // The endpoint itself is healthy: do not count a failure or it gets disabled for everything.
          this.log?.debug?.(`rpc ${this.chain} ${ep.label} rejected ${method} range, rotating`, { error: msg.slice(0, 200) });
          if (tried.size >= this.endpoints.length) throw lastErr; // every endpoint refuses: caller must chunk
          continue;
        }
        ep.consecutiveFailures++;
        if (ep.consecutiveFailures >= 3) {
          const cool = Math.min(300_000, 5_000 * 2 ** (ep.consecutiveFailures - 3));
          ep.disabledUntil = Date.now() + cool;
          this.log?.warn(`rpc ${this.chain} endpoint ${ep.label} disabled for ${Math.round(cool / 1000)}s`, { error: msg.slice(0, 200) });
        } else {
          this.log?.debug?.(`rpc ${this.chain} ${ep.label} ${method} failed, rotating`, { error: msg.slice(0, 200) });
        }
        if (tried.size >= this.endpoints.length) await sleep(Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)), signal);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async send<T>(ep: Endpoint, method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.id++, method, params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      let body: { result?: T; error?: { code?: number; message?: string; data?: unknown } };
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`bad json: ${text.slice(0, 120)}`);
      }
      if (body.error) {
        const m = `${body.error.code ?? ''} ${body.error.message ?? ''}`.toLowerCase();
        if (ROTATE_PATTERNS.some((p) => m.includes(p))) throw new Error(`rpc error: ${m.slice(0, 200)}`);
        if (m.includes('revert') || body.error.code === 3) throw new RpcExecutionError(m.slice(0, 200));
        throw new Error(`rpc error: ${m.slice(0, 200)}`);
      }
      if (body.result === undefined) throw new Error('rpc: empty result');
      return body.result;
    } catch (e) {
      if (ctrl.signal.aborted && !signal?.aborted) throw new Error(`timeout ${ep.label}`);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

const pools = new Map<HistoryChain, RpcPool>();

const PUBLIC_MS = 400; // ~2.5 rps per public endpoint
const KEYED_MS = 100; // ~10 rps for the env (Alchemy free tier) endpoint

export function archiveRpc(chain: HistoryChain, log?: HistoryLogger): RpcPool {
  let p = pools.get(chain);
  if (!p) {
    const env = process.env;
    const urls =
      chain === 'ethereum'
        ? [
            { url: env.ETH_ARCHIVE_RPC_URL ?? '', minIntervalMs: KEYED_MS },
            { url: env.ETH_RPC_URL ?? '', minIntervalMs: KEYED_MS },
            { url: 'https://rpc.mevblocker.io', minIntervalMs: PUBLIC_MS },
            { url: 'https://eth.drpc.org', minIntervalMs: PUBLIC_MS },
            { url: 'https://mainnet.gateway.tenderly.co', minIntervalMs: 600 },
            { url: 'https://eth-mainnet.public.blastapi.io', minIntervalMs: PUBLIC_MS },
          ]
        : [
            { url: env.ARB_ARCHIVE_RPC_URL ?? '', minIntervalMs: KEYED_MS },
            { url: env.ARB_RPC_URL ?? '', minIntervalMs: KEYED_MS },
            { url: 'https://arbitrum.gateway.tenderly.co', minIntervalMs: 600 },
            { url: 'https://arbitrum-one.public.blastapi.io', minIntervalMs: PUBLIC_MS },
          ];
    p = new RpcPool(chain, urls, log);
    pools.set(chain, p);
  } else if (log) {
    p.setLogger(log);
  }
  return p;
}

/** Endpoint known to answer full-range eth_getLogs with topic filters (research: arbitrum tenderly). */
export const FULL_RANGE_LOGS_URL: Record<HistoryChain, string> = {
  ethereum: 'https://mainnet.gateway.tenderly.co',
  arbitrum: 'https://arbitrum.gateway.tenderly.co',
};

export function logsRpc(chain: HistoryChain, log?: HistoryLogger): RpcPool {
  return new RpcPool(chain, [{ url: FULL_RANGE_LOGS_URL[chain], minIntervalMs: 600 }], log);
}

export function toHex(n: number | bigint): `0x${string}` {
  return `0x${BigInt(n).toString(16)}`;
}
