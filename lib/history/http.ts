// Small HTTP helper for keyless REST sources (DefiLlama, Frankfurter, Safe, Blockscout):
// per-host throttle (min interval between request starts), timeout, retry with backoff on 429/5xx.
import { sleep, throwIfAborted } from './types';

const hostNextSlot = new Map<string, number>();
const HOST_MIN_INTERVAL_MS: Record<string, number> = {
  'coins.llama.fi': 120,
  'api.frankfurter.app': 300,
  'api.frankfurter.dev': 300,
  'eth.blockscout.com': 250,
  'safe-transaction-mainnet.safe.global': 400,
  'safe-transaction-arbitrum.safe.global': 400,
};

async function takeSlot(host: string, signal?: AbortSignal): Promise<void> {
  const interval = HOST_MIN_INTERVAL_MS[host] ?? 250;
  const now = Date.now();
  const slot = Math.max(now, hostNextSlot.get(host) ?? 0);
  hostNextSlot.set(host, slot + interval);
  if (slot > now) await sleep(slot - now, signal);
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
  ) {
    super(message);
  }
}

export interface FetchJsonOptions {
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
  init?: RequestInit;
  /** Statuses that should be returned as null instead of throwing (e.g. 404). */
  nullOn?: number[];
}

export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T | null> {
  const { signal, retries = 5, timeoutMs = 30_000, init, nullOn = [] } = opts;
  const host = new URL(url).host;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(signal);
    await takeSlot(host, signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as T;
      if (nullOn.includes(res.status)) return null;
      lastErr = new HttpError(`HTTP ${res.status} for ${url.slice(0, 160)}`, res.status, text.slice(0, 300));
      if (res.status !== 429 && res.status < 500) throw lastErr;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt), signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
      await sleep(backoff(attempt), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function backoff(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}
