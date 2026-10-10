// Canonical DefiLlama price keys for history.
// Arbitrum token-address history is shallow (starts 2024-08), so well-known assets map to coingecko ids.
import { NATIVE_TOKEN, type HistoryChain } from './types';

export const ETH_KEY = 'coingecko:ethereum';

const BY_ADDRESS: Record<HistoryChain, Record<string, string>> = {
  ethereum: {
    [NATIVE_TOKEN]: ETH_KEY,
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': ETH_KEY, // WETH
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'coingecko:wrapped-bitcoin', // WBTC
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'coingecko:usd-coin', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 'coingecko:tether', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f': 'coingecko:dai', // DAI
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': 'coingecko:wrapped-steth', // wstETH
    '0xb50721bcf8d664c30412cfbc6cf7a15145234ad1': 'coingecko:arbitrum', // ARB on L1
  },
  arbitrum: {
    [NATIVE_TOKEN]: ETH_KEY,
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1': ETH_KEY, // WETH
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'coingecko:wrapped-bitcoin', // WBTC
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'coingecko:usd-coin', // USDC native
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'coingecko:usd-coin', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'coingecko:tether', // USDT / USDT0
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'coingecko:dai', // DAI
    '0x912ce59144191c1204e64559fe8253a0e49e6548': 'coingecko:arbitrum', // ARB
    '0x5979d7b546e38e414f7e9822514be443a4800529': 'coingecko:wrapped-steth', // wstETH
  },
};

/** Symbol fallback, applied ONLY to trusted tokens (Aave reserve underlyings), never to arbitrary ERC20s (spam). */
const BY_SYMBOL: Record<string, string> = {
  ETH: ETH_KEY,
  WETH: ETH_KEY,
  WBTC: 'coingecko:wrapped-bitcoin',
  USDC: 'coingecko:usd-coin',
  'USDC.E': 'coingecko:usd-coin',
  USDCN: 'coingecko:usd-coin',
  USDT: 'coingecko:tether',
  USDT0: 'coingecko:tether',
  'USD₮0': 'coingecko:tether',
  DAI: 'coingecko:dai',
  ARB: 'coingecko:arbitrum',
  WSTETH: 'coingecko:wrapped-steth',
};

export function canonicalPriceKey(chain: HistoryChain, token: string, opts: { symbol?: string | null; trusted?: boolean } = {}): string {
  const addr = token.toLowerCase();
  const known = BY_ADDRESS[chain][addr];
  if (known) return known;
  if (opts.trusted && opts.symbol) {
    const s = BY_SYMBOL[opts.symbol.toUpperCase()];
    if (s) return s;
  }
  return `${chain}:${addr}`;
}
