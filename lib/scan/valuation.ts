// Current prices (DefiLlama POST /prices, max 200 coins per request) and valuation helpers.
// Aave aTokens / debt tokens are always priced by their underlying canonical key; debt is negated
// here (DefiLlama would return a negative price for a debt token address, which we never query).
import { fetchJson } from '../history/http';
import type { Logger } from './log';

const LLAMA = 'https://coins.llama.fi';
const MAX_PER_REQUEST = 200;

export interface CurrentPrice {
  usd: number;
  symbol?: string;
  decimals?: number;
  timestamp?: number;
  confidence?: number;
}

export interface PriceLookup {
  prices: Map<string, CurrentPrice>;
  /** Keys whose request succeeded (absent from `prices` there means DefiLlama has no price). */
  answered: Set<string>;
}

interface LlamaPrices {
  coins?: Record<string, { price?: number; symbol?: string; decimals?: number; timestamp?: number; confidence?: number }>;
}

export async function fetchCurrentPrices(keys: string[], log?: Logger, signal?: AbortSignal): Promise<PriceLookup> {
  const uniq = [...new Set(keys.filter(Boolean))];
  const out: PriceLookup = { prices: new Map(), answered: new Set() };
  for (let i = 0; i < uniq.length; i += MAX_PER_REQUEST) {
    const chunk = uniq.slice(i, i + MAX_PER_REQUEST);
    try {
      const j = await fetchJson<LlamaPrices>(`${LLAMA}/prices`, {
        signal,
        retries: 4,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ coins: chunk, searchWidth: '4h' }) },
      });
      for (const k of chunk) out.answered.add(k);
      for (const [k, v] of Object.entries(j?.coins ?? {})) {
        if (typeof v.price === 'number' && Number.isFinite(v.price)) {
          out.prices.set(k, { usd: v.price, symbol: v.symbol, decimals: v.decimals, timestamp: v.timestamp, confidence: v.confidence });
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      log?.warn('defillama current prices failed', { keys: chunk.length, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Look up a price case-insensitively on the address part (DefiLlama echoes keys as sent, but be safe). */
export function priceOf(lookup: PriceLookup, key: string | null | undefined): number | undefined {
  if (!key) return undefined;
  const p = lookup.prices.get(key) ?? lookup.prices.get(key.toLowerCase());
  if (p) return p.usd;
  for (const [k, v] of lookup.prices) if (k.toLowerCase() === key.toLowerCase()) return v.usd;
  return undefined;
}

export function minuteTs(nowMs = Date.now()): number {
  return Math.floor(nowMs / 60_000) * 60;
}
