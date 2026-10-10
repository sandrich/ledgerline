// Arbitrum native bridge: address aliasing, bridge contracts and pairing of the L1 and L2 legs of a
// bridge transfer between tracked addresses.
//
// - L1 -> L2 (deposit): the tracked side sends ETH to the Inbox (or tokens to an L1 gateway); on
//   Arbitrum the ETH arrives from the ALIASED L1 sender (L1 address + 0x1111...1111 mod 2^160) and
//   tokens are minted from 0x0. Takes about 10-15 minutes.
// - L2 -> L1 (withdrawal): ETH is sent to ArbSys (0x...64) or tokens are burned (to 0x0); after the
//   challenge period (about 7 days) the L1 Bridge pays out ETH or an L1 gateway releases the tokens.
// A pair (both legs at tracked addresses, same asset, amount within fees, time window) is stored in
// bridge_pairs and both legs are classified as a transfer between the two tracked addresses
// (internal), so it never counts as a deposit / withdrawal. An unpaired leg with a bridge contract
// counts once as a deposit / withdrawal on the tracked side.
import type { Chain } from '../queries/api-types';
import { all, tx, type QDb } from '../queries/db';

const MOD = 1n << 160n;
const OFFSET = 0x1111000000000000000000000000000000001111n;

const hex40 = (v: bigint): string => `0x${v.toString(16).padStart(40, '0')}`;

/** L1 address as seen on Arbitrum for messages it sends (retryables, ETH deposits). Lowercase. */
export function applyL1ToL2Alias(l1: string): string {
  return hex40((BigInt(l1) + OFFSET) % MOD);
}

/** Inverse of applyL1ToL2Alias. Lowercase. */
export function undoL1ToL2Alias(l2: string): string {
  return hex40((BigInt(l2) - OFFSET + MOD) % MOD);
}

/**
 * Arbitrum One native bridge contracts on Ethereum (lowercase) that hold or pay out the bridged
 * value. Value legs with them are bridge legs. The gateway routers (L1 0x72ce9c84..., L2
 * 0x5288c571...) only forward calls and receive the retryable fee in ETH, so they are plain
 * contracts (protocol interaction, not a flow).
 */
export const L1_BRIDGE: ReadonlyMap<string, string> = new Map([
  ['0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f', 'Arbitrum Inbox'],
  ['0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a', 'Arbitrum Bridge'],
  ['0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840', 'Arbitrum Outbox'],
  ['0xa3a7b6f88361f48403514059f1f16c8e78d60eec', 'Arbitrum L1 ERC20 Gateway'],
  ['0xcee284f754e854890e311e3280b767f80797180d', 'Arbitrum L1 Custom Gateway'],
  ['0xd92023e9d9911199a6711321d1277285e6d4e2db', 'Arbitrum L1 WETH Gateway'],
]);

export const ARBSYS = '0x0000000000000000000000000000000000000064';

/** Arbitrum side: ArbSys (ETH withdrawals) and the L2 gateways. */
export const L2_BRIDGE: ReadonlyMap<string, string> = new Map([
  [ARBSYS, 'ArbSys'],
  ['0x09e9222e96e7b4ae2a407b98d48e330053351eee', 'Arbitrum L2 ERC20 Gateway'],
  ['0x096760f208390250649e3e8763348e783aef5562', 'Arbitrum L2 Custom Gateway'],
  ['0x6c411ad3e74de3e7bd422b94a27770f5b86c623b', 'Arbitrum L2 WETH Gateway'],
]);

export function isBridgeContract(chain: Chain, addr: string): boolean {
  return (chain === 'ethereum' ? L1_BRIDGE : L2_BRIDGE).has(addr);
}

// ---------------------------------------------------------------------------------------------
// Pairing (pure)

const ZERO = '0x0000000000000000000000000000000000000000';

export interface BridgeLeg {
  chain: Chain;
  hash: string;
  ref: string;
  ts: number;
  /** canonical asset key (price key), else token address */
  asset: string;
  amount: number;
  /** the tracked address on this chain */
  own: string;
  /** 'out' = leaving this chain, 'in' = arriving on this chain */
  dir: 'in' | 'out';
  /** L2 inbound ETH: the un-aliased L1 sender when the sender was aliased */
  l1Sender?: string | null;
}

export interface BridgePair {
  l1: BridgeLeg;
  l2: BridgeLeg;
  direction: 'deposit' | 'withdrawal';
}

/** Deposits land on L2 within minutes; allow some slack for slow retryables. */
export const DEPOSIT_WINDOW_SEC = 6 * 3600;
/** Withdrawals can be claimed on L1 any time after the ~7 day challenge period. */
export const WITHDRAWAL_WINDOW_SEC = 60 * 86400;
const WITHDRAWAL_MIN_SEC = 3600;

/** Amount of the arriving leg is the sent amount, at most slightly less (fees taken in kind). */
function amountMatches(sent: number, got: number): boolean {
  if (!(sent > 0) || !(got > 0)) return false;
  return got <= sent * (1 + 1e-9) && got >= sent * 0.995;
}

/**
 * Greedy one-to-one pairing in time order: each outgoing leg takes the matching arriving leg with
 * the closest timestamp. Arriving L2 ETH must come from the aliased sender of the L1 leg.
 */
export function pairBridgeLegs(legs: BridgeLeg[]): BridgePair[] {
  const pairs: BridgePair[] = [];
  const used = new Set<BridgeLeg>();
  const outs = legs.filter((l) => l.dir === 'out').sort((a, b) => a.ts - b.ts || a.hash.localeCompare(b.hash));
  for (const o of outs) {
    const deposit = o.chain === 'ethereum';
    const cands = legs.filter((c) => {
      if (used.has(c) || c.dir !== 'in' || c.chain === o.chain || c.asset !== o.asset) return false;
      // an ETH deposit is sent on L2 by the aliased L1 sender: anything else is unrelated ETH
      if (deposit && c.l1Sender != null && c.l1Sender !== o.own) return false;
      const dt = c.ts - o.ts;
      if (deposit ? dt < -600 || dt > DEPOSIT_WINDOW_SEC : dt < WITHDRAWAL_MIN_SEC || dt > WITHDRAWAL_WINDOW_SEC) return false;
      return amountMatches(o.amount, c.amount);
    });
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(a.ts - o.ts) - Math.abs(b.ts - o.ts));
    const m = cands[0];
    used.add(m);
    pairs.push(deposit ? { l1: o, l2: m, direction: 'deposit' } : { l1: m, l2: o, direction: 'withdrawal' });
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// Pairing (database)

interface CandRow {
  chain: Chain;
  hash: string;
  ref: string;
  ts: number;
  token: string;
  from_addr: string;
  to_addr: string;
  amount: number | null;
  kind_hint: string;
  price_key: string | null;
  t_kind: string | null;
}

const AAVE_KINDS = new Set(['atoken', 'vdebt', 'sdebt']);
/** WETH on Arbitrum: its 0x0 mints / burns are wraps, not gateway bridging (WETH gateway transfers stay unpaired). */
const L2_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';

/** Bridge leg candidates at tracked addresses (see the file comment for what counts). */
export function loadBridgeLegs(db: QDb, own: Set<string>): BridgeLeg[] {
  const rows = all<CandRow>(
    db,
    `SELECT tt.chain, tt.hash, tt.ref, x.ts, tt.token, tt.from_addr, tt.to_addr, tt.amount, tt.kind_hint, t.price_key, t.kind AS t_kind
     FROM tx_transfers tt JOIN tx x ON x.chain = tt.chain AND x.hash = tt.hash
     LEFT JOIN tokens t ON t.chain = tt.chain AND t.address = tt.token
     WHERE tt.kind_hint IN ('erc20', 'native') AND tt.amount > 0 AND COALESCE(t.spam, 0) = 0`,
  );
  const out: BridgeLeg[] = [];
  for (const r of rows) {
    const fromOwn = own.has(r.from_addr);
    const toOwn = own.has(r.to_addr);
    if (fromOwn === toOwn) continue;
    if (AAVE_KINDS.has(r.t_kind ?? '')) continue;
    const native = r.kind_hint === 'native';
    const asset = native ? 'coingecko:ethereum' : r.price_key ?? `${r.chain}:${r.token}`;
    const base = { chain: r.chain, hash: r.hash, ref: r.ref, ts: r.ts, asset, amount: r.amount ?? 0 };
    if (r.chain === 'ethereum') {
      if (fromOwn && L1_BRIDGE.has(r.to_addr)) out.push({ ...base, own: r.from_addr, dir: 'out' });
      else if (toOwn && L1_BRIDGE.has(r.from_addr)) out.push({ ...base, own: r.to_addr, dir: 'in' });
      continue;
    }
    if (!native && r.token === L2_WETH) continue;
    if (fromOwn) {
      // ETH to ArbSys, tokens burned by the gateway
      if ((native && r.to_addr === ARBSYS) || (!native && r.to_addr === ZERO)) out.push({ ...base, own: r.from_addr, dir: 'out' });
    } else if (native) {
      // ETH deposits arrive from the aliased L1 sender; only those can pair (see pairBridgeLegs)
      out.push({ ...base, own: r.to_addr, dir: 'in', l1Sender: undoL1ToL2Alias(r.from_addr) });
    } else if (r.from_addr === ZERO) {
      out.push({ ...base, own: r.to_addr, dir: 'in' });
    }
  }
  return out;
}

/** Recompute bridge_pairs from the whole ledger (cheap: only bridge candidate legs). Returns the pair count. */
export function rebuildBridgePairs(db: QDb, own: Set<string>): number {
  const pairs = pairBridgeLegs(loadBridgeLegs(db, own));
  return tx(db, () => {
    db.prepare('DELETE FROM bridge_pairs').run();
    const ins = db.prepare(
      'INSERT OR IGNORE INTO bridge_pairs (l1_hash, l1_ref, l1_addr, l2_hash, l2_ref, l2_addr, direction) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const p of pairs) ins.run(p.l1.hash, p.l1.ref, p.l1.own, p.l2.hash, p.l2.ref, p.l2.own, p.direction);
    return pairs.length;
  });
}
