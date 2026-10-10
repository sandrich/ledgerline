// Transaction classification from the point of view of a scope (a set of tracked addresses).
// Pure functions: no database, so they are unit tested directly (lib/ledger/__tests__).
//
// Every value leg (ERC20 Transfer or native ETH movement touching the scope) gets a role:
//   internal      both sides in the scope
//   own-in/out    the other side is a tracked address OUTSIDE the scope (e.g. the owner EOA seen from a
//                 wallet that only holds the Safe): a real deposit / withdrawal for this scope
//   aave          aToken / debt token mint (from 0x0) or burn (to 0x0)
//   protocol      underlying moving between the scope and an Aave aToken contract (the reserve)
//   wrap          WETH minted / burned (0x0 counterparty) or native ETH sent to / received from WETH:
//                 value neutral (on Arbitrum the matching native leg is an invisible internal call)
//   ext-in/out    anything else (external counterparty)
// Spam legs (tokens.spam = 1, zero amounts from address poisoning) are dropped first; an incoming
// only external transaction worth less than DUST_USD (poisoning dust) is spam as well.
//
// Kind priority (first match wins, in this order in classifyTx):
//   1. spam      nothing but spam legs
//   2. own       value crosses to / from a tracked address outside the scope: send / receive
//                (netUsd = own legs only; swap, flash loan and fee legs in the same batch are ignored)
//   3. aave      aave-supply / -withdraw / -borrow / -repay, the largest action by USD (netUsd 0)
//   4. external  swap (different assets out and in, netUsd 0), receive, send, other (netUsd = in - out)
//   5. internal  only legs between scope addresses (netUsd 0)
//   6. approval  only Approval logs by a scope address
//   7. other
// A DeFi Saver style Safe batch (repay + withdraw + swap + send USDC to the owner EOA in ONE tx) is
// therefore aave-withdraw in the overview (nothing left the scope; hiding internal transfers must not
// hide a position close) and send (to the owner EOA) in a scope without the EOA.
import type { Chain, TxKind, TxTransfer } from '../queries/api-types';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE = ZERO;

export const WRAPPED_NATIVE: Record<Chain, string> = {
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  arbitrum: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};

/** Incoming-only external transactions worth less than this (all legs priced) are treated as spam. */
export const DUST_USD = 0.1;

export type LegHint = 'erc20' | 'native' | 'approval' | 'call';

export interface LegInput {
  ref: string;
  /** token contract (lowercase), zero address for native */
  token: string;
  from: string;
  to: string;
  amountRaw: string | null;
  amount: number | null;
  usd: number | null;
  hint: LegHint;
  /** tokens.kind joined at query time; null when the token is unknown */
  tokenKind: string | null;
  spam: boolean;
  symbol: string | null;
  logo: string | null;
  /** canonical asset key (tokens.price_key), used to tell swaps from same-asset round trips */
  priceKey: string | null;
}

export interface OwnInfo {
  id: number;
  /** address label, else first wallet name */
  label: string | null;
}

export interface ClassifyContext {
  chain: Chain;
  /** lowercase addresses of the scope */
  scope: Set<string>;
  /** every tracked address (lowercase) */
  own: Map<string, OwnInfo>;
  /** Aave aToken contracts on this chain (lowercase) */
  aTokens: Set<string>;
}

export type LegRole = 'internal' | 'own-in' | 'own-out' | 'aave' | 'protocol' | 'wrap' | 'ext-in' | 'ext-out';

export interface Classified {
  kind: TxKind;
  transfers: TxTransfer[];
  counterparty: string | null;
  counterpartyLabel: string | null;
  netUsd: number | null;
}

const isZeroRaw = (r: string | null, amount: number | null): boolean => (r != null ? /^0*$/.test(r.replace(/^0x/, '')) || r === '0' : amount === 0);

export function legRole(l: LegInput, ctx: ClassifyContext): LegRole {
  const fromIn = ctx.scope.has(l.from);
  const toIn = ctx.scope.has(l.to);
  if (fromIn && toIn) return 'internal';
  const other = fromIn ? l.to : l.from;
  const inbound = toIn;
  if (ctx.own.has(other) && other !== ZERO) return inbound ? 'own-in' : 'own-out';
  const k = l.tokenKind;
  if ((k === 'atoken' || k === 'vdebt' || k === 'sdebt') && other === ZERO) return 'aave';
  if (ctx.aTokens.has(other)) return 'protocol';
  const weth = WRAPPED_NATIVE[ctx.chain];
  if (l.token === weth && other === ZERO) return 'wrap';
  if (l.token === NATIVE && other === weth) return 'wrap';
  return inbound ? 'ext-in' : 'ext-out';
}

function aaveAction(l: LegInput, ctx: ClassifyContext): TxKind {
  const mint = l.from === ZERO && ctx.scope.has(l.to);
  if (l.tokenKind === 'atoken') return mint ? 'aave-supply' : 'aave-withdraw';
  return mint ? 'aave-borrow' : 'aave-repay';
}

function sumUsd(legs: LegInput[], sign: (l: LegInput) => number): number | null {
  let s = 0;
  for (const l of legs) {
    if (l.usd == null) return null;
    s += sign(l) * l.usd;
  }
  return s;
}

const assetOf = (l: LegInput): string => l.priceKey ?? l.token;

export function toTransfer(l: LegInput, ctx: ClassifyContext): TxTransfer {
  const fromIn = ctx.scope.has(l.from);
  const toIn = ctx.scope.has(l.to);
  const fo = ctx.own.get(l.from);
  const to = ctx.own.get(l.to);
  return {
    token: l.token,
    symbol: l.symbol ?? (l.token === NATIVE ? 'ETH' : `${l.token.slice(0, 6)}...${l.token.slice(-4)}`),
    logo: l.logo,
    amount: Math.abs(l.amount ?? 0),
    usd: l.spam ? null : l.usd,
    direction: fromIn && toIn ? 'internal' : toIn ? 'in' : 'out',
    from: l.from,
    to: l.to,
    fromLabel: fo ? fo.label : null,
    toLabel: to ? to.label : null,
    fromOwn: !!fo,
    toOwn: !!to,
  };
}

/** Largest leg by USD (unpriced legs count as 0), ties by order. */
function largest(legs: LegInput[]): LegInput | null {
  let best: LegInput | null = null;
  for (const l of legs) if (!best || Math.abs(l.usd ?? 0) > Math.abs(best.usd ?? 0)) best = l;
  return best;
}

export function classifyTx(all: LegInput[], ctx: ClassifyContext): Classified {
  const touching = all.filter((l) => ctx.scope.has(l.from) || ctx.scope.has(l.to));
  const approvals = touching.filter((l) => l.hint === 'approval' && ctx.scope.has(l.from));
  const value = touching.filter((l) => l.hint === 'erc20' || l.hint === 'native');
  const spamLegs = value.filter((l) => l.spam || isZeroRaw(l.amountRaw, l.amount));
  const real = value.filter((l) => !spamLegs.includes(l));
  const out = (kind: TxKind, legs: LegInput[], netUsd: number | null, cp: string | null = null): Classified => ({
    kind,
    transfers: legs.map((l) => toTransfer(l, ctx)),
    counterparty: cp,
    counterpartyLabel: cp ? ctx.own.get(cp)?.label ?? null : null,
    netUsd,
  });

  if (!real.length) {
    if (spamLegs.length) return out('spam', spamLegs, 0);
    if (approvals.length) return out('approval', [], 0);
    return out('other', [], 0);
  }

  const roles = new Map<LegInput, LegRole>(real.map((l) => [l, legRole(l, ctx)]));
  const by = (...r: LegRole[]) => real.filter((l) => r.includes(roles.get(l)!));
  const otherSide = (l: LegInput) => (ctx.scope.has(l.from) ? l.to : l.from);

  // 2. value crossing to / from a tracked address outside the scope
  const own = by('own-in', 'own-out');
  if (own.length) {
    const net = sumUsd(own, (l) => (roles.get(l) === 'own-in' ? 1 : -1));
    const ins = own.filter((l) => roles.get(l) === 'own-in');
    const outs = own.filter((l) => roles.get(l) === 'own-out');
    const inUsd = ins.reduce((s, l) => s + (l.usd ?? 0), 0);
    const outUsd = outs.reduce((s, l) => s + (l.usd ?? 0), 0);
    const kind: TxKind = !outs.length ? 'receive' : !ins.length ? 'send' : inUsd >= outUsd ? 'receive' : 'send';
    const main = largest(kind === 'receive' ? ins : outs) ?? own[0];
    return out(kind, real, net, otherSide(main));
  }

  // 3. Aave
  const aave = by('aave');
  if (aave.length) {
    const totals = new Map<TxKind, number>();
    for (const l of aave) {
      const k = aaveAction(l, ctx);
      totals.set(k, (totals.get(k) ?? 0) + Math.abs(l.usd ?? 0) + 1e-9);
    }
    const kind = [...totals].sort((a, b) => b[1] - a[1])[0][0];
    return out(kind, real, 0);
  }

  // 4. external counterparties
  const ext = by('ext-in', 'ext-out');
  if (ext.length) {
    const ins = ext.filter((l) => roles.get(l) === 'ext-in');
    const outs = ext.filter((l) => roles.get(l) === 'ext-out');
    if (ins.length && outs.length) {
      const inAssets = new Set(ins.map(assetOf));
      const outAssets = new Set(outs.map(assetOf));
      const differ = [...inAssets].some((a) => !outAssets.has(a)) || [...outAssets].some((a) => !inAssets.has(a));
      // wrap legs (ETH <-> WETH) count as the same asset, so ETH -> USDC through a router is a swap
      if (differ) return out('swap', real, 0, otherSide(largest(outs)!));
      return out('other', real, sumUsd(ext, (l) => (roles.get(l) === 'ext-in' ? 1 : -1)), otherSide(largest(ext)!));
    }
    if (ins.length) {
      const v = sumUsd(ins, () => 1);
      // address poisoning dust (e.g. 0.017 USDT0 or 1 wei ETH from a lookalike address): hidden as spam
      if (v != null && v < DUST_USD && !by('internal', 'aave', 'protocol', 'wrap').length) return out('spam', real, 0);
      return out('receive', real, v, otherSide(largest(ins)!));
    }
    return out('send', real, sumUsd(outs, () => -1), otherSide(largest(outs)!));
  }

  // 5. only transfers between scope addresses
  if (by('internal').length) return out('internal', real, 0);
  // wrap / protocol only
  return out('other', real, 0);
}
