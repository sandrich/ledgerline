// Static lookups for the read models: ranges, Aave market -> chain, canonical asset labels, spam rules.
import type { Chain, HistoryRange } from './api-types';

export const DAY = 86_400;
export const HOUR = 3_600;
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
export const ETH_KEY = 'coingecko:ethereum';
export const MAX_POINTS = 400;

export const RANGE_SECONDS: Record<Exclude<HistoryRange, 'all'>, number> = {
  '24h': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '1y': 365 * DAY,
};

export const CHANGE_WINDOWS = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '1y': 365 * DAY } as const;

/** Aave v3 market keys (see lib/history/aave.ts). Unknown keys fall back to their prefix. */
export const AAVE_MARKETS: Record<string, Chain> = {
  'eth-core': 'ethereum',
  'eth-prime': 'ethereum',
  'eth-etherfi': 'ethereum',
  'eth-horizon': 'ethereum',
  'arb-core': 'arbitrum',
};

export function marketChain(market: string): Chain {
  const known = AAVE_MARKETS[market];
  if (known) return known;
  return market.startsWith('arb') ? 'arbitrum' : 'ethereum';
}

export function isChain(v: unknown): v is Chain {
  return v === 'ethereum' || v === 'arbitrum';
}

/** Display symbol/name for canonical (coingecko) keys so WETH + aWETH + native ETH read as one asset. */
export const CANONICAL_LABELS: Record<string, { symbol: string; name: string }> = {
  'coingecko:ethereum': { symbol: 'ETH', name: 'Ethereum' },
  'coingecko:wrapped-bitcoin': { symbol: 'WBTC', name: 'Wrapped Bitcoin' },
  'coingecko:usd-coin': { symbol: 'USDC', name: 'USD Coin' },
  'coingecko:tether': { symbol: 'USDT', name: 'Tether' },
  'coingecko:dai': { symbol: 'DAI', name: 'Dai' },
  'coingecko:arbitrum': { symbol: 'ARB', name: 'Arbitrum' },
  'coingecko:wrapped-steth': { symbol: 'wstETH', name: 'Wrapped stETH' },
};

export const PROTOCOL_LABELS: Record<string, string> = {
  wallet: 'Wallet',
  'aave-v3': 'Aave V3',
};

export const CHAIN_LABELS: Record<Chain, string> = {
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
};

const SPAM_RE = /(https?:\/\/|www\.|\.(com|io|xyz|org|net|app|finance|site|top|me)\b|claim|airdrop|visit|reward)/i;

export function looksSpam(symbol: string | null | undefined, name: string | null | undefined): boolean {
  return SPAM_RE.test(symbol ?? '') || SPAM_RE.test(name ?? '');
}

/** Health factor as stored (float). >= 1e30 (uint max style) or <= 0 means "no debt" -> null. */
export function normalizeHealthFactor(hf: number | null | undefined): number | null {
  if (hf == null || !Number.isFinite(hf) || hf <= 0 || hf >= 1e30) return null;
  return hf;
}

export const WALLET_COLORS = ['#ea5a1f', '#2f2a24', '#c99a2e', '#3f8f5a', '#b8432f', '#5b6b8c', '#8a6d3b', '#4f8a8b'];

// ---------- canonical assets (PnL by asset, net exposure, liquidation points, stable share) ----------

const ASSET_BY_KEY: Record<string, string> = {
  'coingecko:ethereum': 'ETH',
  'coingecko:weth': 'ETH',
  'coingecko:wrapped-bitcoin': 'BTC',
  'coingecko:bitcoin': 'BTC',
  'coingecko:usd-coin': 'USD',
  'coingecko:tether': 'USD',
  'coingecko:dai': 'USD',
  'coingecko:usds': 'USD',
  'coingecko:ethena-usde': 'USD',
  'coingecko:frax': 'USD',
  'coingecko:gho': 'USD',
  'coingecko:paypal-usd': 'USD',
  'coingecko:liquity-usd': 'USD',
  'coingecko:crvusd': 'USD',
};

const STABLE_SYMBOL_RE = /^(USDC(\.e)?|USDCN|USDT0?|USD₮0?|DAI|USDS|USDE|FRAX|LUSD|GHO|PYUSD|CRVUSD|USDBC|TUSD|BUSD|SUSD|USDP|RLUSD|USD0)$/i;

/** Display symbol of a canonical asset id. */
export const ASSET_SYMBOLS: Record<string, string> = { ETH: 'ETH', BTC: 'BTC', USD: 'USD' };

/**
 * Canonical asset id for a price key: ETH (ETH / WETH / aWETH / WETH debt), BTC (WBTC), USD (any
 * USD stablecoin), else the token's display symbol (upper case) or the key itself.
 */
export function assetOf(priceKey: string, symbol?: string | null): string {
  const known = ASSET_BY_KEY[priceKey];
  if (known) return known;
  const sym = (CANONICAL_LABELS[priceKey]?.symbol ?? symbol ?? '').trim();
  if (sym && STABLE_SYMBOL_RE.test(sym)) return 'USD';
  if (/^W?ETH$/i.test(sym)) return 'ETH';
  if (/^W?BTC$/i.test(sym)) return 'BTC';
  return sym ? sym.toUpperCase() : priceKey;
}

export function assetSymbol(asset: string, fallback?: string | null): string {
  return ASSET_SYMBOLS[asset] ?? fallback ?? asset;
}
