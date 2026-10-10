// Smart wallet discovery: for every tracked EOA, find smart wallets it owns and store them as
// suggestions (smart_wallet_suggestions, read by lib/queries/suggestions.ts):
// - Safes: Safe transaction service GET /api/v1/owners/{checksum address}/safes/ on mainnet and
//   Arbitrum (only chains the EOA is tracked on).
// - DSProxy (DeFi Saver, Maker): ProxyRegistry.proxies(owner) on Ethereum, confirmed with the
//   proxy's owner() (a DSProxy can be handed over to a new owner; the registry keeps the old entry).
//   Registry verified on chain 2026-10: it has code and proxies() returns the proxy of a known owner.
// Runs from the discovery job, at most once per day per EOA (meta 'smart-wallets:<addressId>').
// Network failures are logged and retried on the next discovery run; never fatal for discovery.
import { getAddress } from 'viem';
import { scanGetMeta, scanListAddresses, scanSetMeta, type ScanAddress, type ScanChain } from '../db/repos-scan';
import { fetchJson } from '../history/http';
import type { Db } from '../history/types';
import { throwIfAborted } from '../history/types';
import type { QDb } from '../queries/db';
import type { SuggestionSource } from '../queries/api-types';
import { upsertSuggestion } from '../queries/suggestions';
import { errMsg, type Logger } from './log';
import { latestRpc } from './rpc-latest';

export const DSPROXY_REGISTRY = '0x4678f0a6958e4d2bc4f1baf7bc52e8f3564f3fe4';
const SEL_PROXIES = '0xc4552791'; // proxies(address)
const SEL_OWNER = '0x8da5cb5b'; // owner()
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86400;

const SAFE_HOST: Record<ScanChain, string> = {
  ethereum: 'safe-transaction-mainnet.safe.global',
  arbitrum: 'safe-transaction-arbitrum.safe.global',
};

export interface FoundWallet {
  chain: ScanChain;
  address: string;
  source: SuggestionSource;
}

const word = (addr: string): string => addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addrFromWord = (w: string | null | undefined): string | null => (w && w.length >= 66 ? `0x${w.slice(-40)}`.toLowerCase() : null);

/** Safes owned by `owner` on one chain ([] when the service does not know the owner). Throws on network errors. */
export async function safesOwnedBy(chain: ScanChain, owner: string, signal?: AbortSignal): Promise<string[]> {
  const j = await fetchJson<{ safes?: string[] }>(`https://${SAFE_HOST[chain]}/api/v1/owners/${getAddress(owner)}/safes/`, {
    signal,
    retries: 3,
    nullOn: [404, 422],
  });
  if (!j) return [];
  return (j.safes ?? []).filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s)).map((s) => s.toLowerCase());
}

/** The DSProxy registered for `owner` on Ethereum, if it still belongs to `owner`. */
export async function dsProxyOf(owner: string, log?: Logger, signal?: AbortSignal): Promise<string | null> {
  const rpc = latestRpc('ethereum', log);
  const res = await rpc.request<string>('eth_call', [{ to: DSPROXY_REGISTRY, data: `${SEL_PROXIES}${word(owner)}` }, 'latest'], signal, 4);
  const proxy = addrFromWord(res);
  if (!proxy || proxy === ZERO) return null;
  const o = addrFromWord(await rpc.request<string>('eth_call', [{ to: proxy, data: SEL_OWNER }, 'latest'], signal, 4));
  return o === owner.toLowerCase() ? proxy : null;
}

export interface SmartWalletRunOptions {
  db: Db;
  log: Logger;
  signal?: AbortSignal;
  addressIds?: number[];
  /** ignore the once-per-day throttle */
  force?: boolean;
  now?: number;
}

export interface SmartWalletRunResult {
  checked: number;
  found: FoundWallet[];
  newSuggestions: number;
}

/** True when the address is (or may be) an EOA on that chain: contracts never own Safes here. */
const eoaOn = (a: ScanAddress, chain: ScanChain): boolean => a.chains.includes(chain) && a.isContract[chain] !== true;

export async function runSmartWalletDiscovery(opts: SmartWalletRunOptions): Promise<SmartWalletRunResult> {
  const { db, log, signal } = opts;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const res: SmartWalletRunResult = { checked: 0, found: [], newSuggestions: 0 };
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'smart_wallet_suggestions'").get();
  if (!hasTable) return res;
  const addrs = scanListAddresses(db, opts.addressIds).filter((a) => a.chains.some((c) => eoaOn(a, c)));
  for (const a of addrs) {
    throwIfAborted(signal);
    const key = `smart-wallets:${a.id}`;
    const last = Number(scanGetMeta(db, key) ?? NaN);
    if (!opts.force && Number.isFinite(last) && now - last < DAY) continue;
    res.checked++;
    const found: FoundWallet[] = [];
    let failed = false;
    for (const chain of ['ethereum', 'arbitrum'] as ScanChain[]) {
      if (!eoaOn(a, chain)) continue;
      try {
        const safes = await safesOwnedBy(chain, a.address, signal);
        for (const s of safes) found.push({ chain, address: s, source: 'safe' });
      } catch (e) {
        if (signal?.aborted) throw e;
        failed = true;
        log.warn(`smart wallets: Safe lookup on ${chain} failed for ${a.address}`, { error: errMsg(e) });
      }
    }
    if (eoaOn(a, 'ethereum')) {
      try {
        const p = await dsProxyOf(a.address, log, signal);
        if (p) found.push({ chain: 'ethereum', address: p, source: 'dsproxy' });
      } catch (e) {
        if (signal?.aborted) throw e;
        failed = true;
        log.warn(`smart wallets: DSProxy lookup failed for ${a.address}`, { error: errMsg(e) });
      }
    }
    for (const f of found) {
      if (upsertSuggestion(db as unknown as QDb, { ...f, ownerAddressId: a.id }, now)) {
        res.newSuggestions++;
        log.info(`smart wallets: ${f.source} ${f.address} on ${f.chain} owned by ${a.address}`);
      }
    }
    res.found.push(...found);
    if (!failed) scanSetMeta(db, key, String(now));
  }
  return res;
}
