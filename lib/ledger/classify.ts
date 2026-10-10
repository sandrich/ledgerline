// Transaction classification from the point of view of a scope (a set of tracked addresses).
// Pure functions: no database, so they are unit tested directly (lib/ledger/__tests__).
//
// Every value leg (ERC20 Transfer or native ETH movement touching the scope) gets a role:
//   internal      both sides in the scope
//   own-in/out    the other side is a tracked address OUTSIDE the scope (e.g. the owner EOA seen from a
//                 wallet that only holds the Safe): a real deposit / withdrawal for this scope
//   aave          aToken / debt token mint (from 0x0) or burn (to 0x0)
//   protocol      underlying moving between the scope and an Aave aToken contract (the reserve)
//   curve         value moving between the scope and a Curve crvUSD / LlamaLend controller, AMM or
//                 vault (ctx.curve, from the curve_markets registry): a loan action, never a flow
//   wrap          WETH minted / burned (0x0 counterparty) or native ETH sent to / received from WETH:
//                 value neutral (on Arbitrum the matching native leg is an invisible internal call)
//   bridge-in/out unpaired leg with an Arbitrum native bridge contract (lib/ledger/bridge.ts): the
//                 other side is not tracked, so it counts once as a deposit / withdrawal. A PAIRED
//                 bridge leg arrives here with the bridge contract replaced by the tracked address on
//                 the other chain (lib/ledger/read.ts), so it is internal / own like any transfer.
//   ext-in/out    externally owned counterparty (EOA per the eth_getCode cache, EIP-7702 delegated
//                 EOAs included): exchanges, other people. The ONLY source of deposits / withdrawals
//                 besides own and bridge legs.
//   contract-in/out a contract counterparty (protocol, router, DSProxy, Safe, ...), 0x0 (mints and
//                 burns of non Aave tokens) or a counterparty whose code is not known yet: a protocol
//                 interaction, never a deposit or withdrawal. On Arbitrum, ETH from the alias of a
//                 tracked L1 address is attributed to that address (own / internal).
// Spam legs (tokens.spam = 1, zero amounts from address poisoning) are dropped first; an incoming
// only external transaction worth less than DUST_USD (poisoning dust) is spam as well.
//
// Kind priority (first match wins, in this order in classifyTx):
//   1. spam      nothing but spam legs
//   2. own       value crosses to / from a tracked address outside the scope: send / receive
//                (netUsd = own legs only; swap, flash loan and fee legs in the same batch are ignored)
//   3. lending   aave-supply / -withdraw / -borrow / -repay and curve-borrow / -repay / -deposit / -withdraw
//                (legs with a crvUSD / LlamaLend controller, AMM or vault, ctx.curve), the largest action
//                by USD (netUsd 0); a Curve borrow / repay leg outranks the collateral legs of the same tx
//   4. external  swap (different assets out and in, netUsd 0); with EOA / bridge legs: receive / send by
//                the sign of their per tx net (in and out legs cancel), netUsd = that net; contract
//                legs only: other (protocol interaction, netUsd = in - out, never a flow), except value
//                that only comes in from contracts in a tx no tracked address sent (an exchange paying
//                out from a contract hot wallet): receive
//   5. internal  only legs between scope addresses (netUsd 0)
//   6. approval  only Approval logs by a scope address
//   7. other
// A DeFi Saver style Safe batch (repay + withdraw + swap + send USDC to the owner EOA in ONE tx) is
// therefore aave-withdraw in the overview (nothing left the scope; hiding internal transfers must not
// hide a position close) and send (to the owner EOA) in a scope without the EOA.
import type { Chain, TxKind, TxTransfer } from '../queries/api-types';
import { isBridgeContract, undoL1ToL2Alias } from './bridge';

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
  /**
   * eth_getCode cache for this chain: true = contract, false = EOA. Counterparties missing here are
   * treated as contracts (not a flow) until the ledger job has checked them.
   */
  codes?: Map<string, boolean>;
  /** Curve crvUSD / LlamaLend contracts on this chain (lowercase address -> role), from curve_markets */
  curve?: Map<string, CurveRole>;
}

/** Role of a Curve lending contract for the classifier (see lib/protocols/curve-crvusd.ts curveContracts). */
export interface CurveRole {
  role: 'controller' | 'amm' | 'vault';
  /** borrowed token of the market (lowercase): crvUSD for mint markets */
  borrowed: string;
}

export type LegRole =
  | 'internal'
  | 'own-in'
  | 'own-out'
  | 'aave'
  | 'protocol'
  | 'curve'
  | 'wrap'
  | 'bridge-in'
  | 'bridge-out'
  | 'ext-in'
  | 'ext-out'
  | 'contract-in'
  | 'contract-out';

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
  if (ctx.curve?.has(other)) return 'curve';
  const weth = WRAPPED_NATIVE[ctx.chain];
  if (l.token === weth && other === ZERO) return 'wrap';
  if (l.token === NATIVE && other === weth) return 'wrap';
  if (isBridgeContract(ctx.chain, other)) return inbound ? 'bridge-in' : 'bridge-out';
  if (other === ZERO) return inbound ? 'contract-in' : 'contract-out';
  if (ctx.chain === 'arbitrum' && inbound && l.token === NATIVE) {
    const l1 = undoL1ToL2Alias(other);
    if (ctx.scope.has(l1)) return 'internal';
    if (ctx.own.has(l1)) return 'own-in';
  }
  if (ctx.codes?.get(other) === false) return inbound ? 'ext-in' : 'ext-out';
  return inbound ? 'contract-in' : 'contract-out';
}

/** The address a leg exchanges value with, seen from the scope (un-aliased for Arbitrum deposits). */
function counterpartyOf(l: LegInput, ctx: ClassifyContext): string {
  const other = ctx.scope.has(l.from) ? l.to : l.from;
  if (ctx.chain === 'arbitrum' && l.token === NATIVE && ctx.scope.has(l.to) && !ctx.own.has(other)) {
    const l1 = undoL1ToL2Alias(other);
    if (ctx.own.has(l1)) return l1;
  }
  return other;
}

function aaveAction(l: LegInput, ctx: ClassifyContext): TxKind {
  const mint = l.from === ZERO && ctx.scope.has(l.to);
  if (l.tokenKind === 'atoken') return mint ? 'aave-supply' : 'aave-withdraw';
  return mint ? 'aave-borrow' : 'aave-repay';
}

/**
 * Controller: borrowed token in = borrow, out = repay (collateral out to a controller = deposit).
 * AMM: collateral out = deposit (add collateral), in = withdraw (remove collateral, close; also the
 * borrowed token returned from the bands after soft liquidation). Vault (LlamaLend lending): out =
 * deposit, in = withdraw.
 */
function curveAction(l: LegInput, ctx: ClassifyContext): TxKind {
  const c = ctx.curve!.get(ctx.scope.has(l.from) ? l.to : l.from)!;
  const inbound = ctx.scope.has(l.to);
  if (c.role === 'controller' && l.token === c.borrowed) return inbound ? 'curve-borrow' : 'curve-repay';
  return inbound ? 'curve-withdraw' : 'curve-deposit';
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

/**
 * @param sender transaction sender (tx.from) when known. Used for one exception to the contract rule:
 *   value that only flows IN from a contract, in a transaction no tracked address sent, was pushed by
 *   a third party (typically an exchange paying out from a contract hot wallet) and is a deposit.
 */
export function classifyTx(all: LegInput[], ctx: ClassifyContext, sender: string | null = null): Classified {
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
  const otherSide = (l: LegInput) => counterpartyOf(l, ctx);
  const inbound = (l: LegInput) => ctx.scope.has(l.to) && !ctx.scope.has(l.from);

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

  // 3. lending protocols (Aave mints / burns, Curve loan legs)
  const aave = by('aave');
  const curve = by('curve');
  if (aave.length || curve.length) {
    const totals = new Map<TxKind, number>();
    for (const l of aave) {
      const k = aaveAction(l, ctx);
      totals.set(k, (totals.get(k) ?? 0) + Math.abs(l.usd ?? 0) + 1e-9);
    }
    // a Curve loan open / close moves more collateral than debt: the debt action names the tx
    const curveKinds = curve.map((l) => [l, curveAction(l, ctx)] as const);
    const debtAction = curveKinds.some(([, k]) => k === 'curve-borrow' || k === 'curve-repay');
    for (const [l, k] of curveKinds) {
      if (debtAction && k !== 'curve-borrow' && k !== 'curve-repay') continue;
      totals.set(k, (totals.get(k) ?? 0) + Math.abs(l.usd ?? 0) + 1e-9);
    }
    const kind = [...totals].sort((a, b) => b[1] - a[1])[0][0];
    return out(kind, real, 0);
  }

  // 4. counterparties outside the tracked set
  const ext = by('ext-in', 'ext-out', 'bridge-in', 'bridge-out', 'contract-in', 'contract-out');
  if (ext.length) {
    const ins = ext.filter(inbound);
    const outs = ext.filter((l) => !inbound(l));
    if (ins.length && outs.length) {
      const inAssets = new Set(ins.map(assetOf));
      const outAssets = new Set(outs.map(assetOf));
      const differ = [...inAssets].some((a) => !outAssets.has(a)) || [...outAssets].some((a) => !inAssets.has(a));
      // wrap legs (ETH <-> WETH) count as the same asset, so ETH -> USDC through a router is a swap
      if (differ) return out('swap', real, 0, otherSide(largest(outs)!));
    }
    if (ins.length && !outs.length) {
      const v = sumUsd(ins, () => 1);
      // address poisoning dust (e.g. 0.017 USDT0 or 1 wei ETH from a lookalike address): hidden as spam
      if (v != null && v < DUST_USD && !by('internal', 'aave', 'protocol', 'curve', 'wrap').length) return out('spam', real, 0);
    }
    // deposits / withdrawals: only value exchanged with EOAs (or an unpaired bridge), netted per tx
    const flow = by('ext-in', 'ext-out', 'bridge-in', 'bridge-out');
    if (flow.length) {
      const net = sumUsd(flow, (l) => (inbound(l) ? 1 : -1));
      const fin = flow.filter(inbound);
      const fout = flow.filter((l) => !inbound(l));
      let kind: TxKind;
      if (!fout.length) kind = 'receive';
      else if (!fin.length) kind = 'send';
      else kind = net == null || Math.abs(net) < DUST_USD ? 'other' : net > 0 ? 'receive' : 'send';
      const main = largest(kind === 'send' ? fout : kind === 'receive' ? fin : flow)!;
      return out(kind, real, kind === 'other' ? 0 : net, otherSide(main));
    }
    const pushed = !outs.length && !(sender && ctx.own.has(sender)) && !by('internal', 'aave', 'protocol', 'curve', 'wrap').length;
    if (pushed) return out('receive', real, sumUsd(ins, () => 1), otherSide(largest(ins)!));
    // contracts only: a protocol interaction, the value moved is shown but never a flow
    return out('other', real, sumUsd(ext, (l) => (inbound(l) ? 1 : -1)), otherSide(largest(ext)!));
  }

  // 5. only transfers between scope addresses
  if (by('internal').length) return out('internal', real, 0);
  // wrap / protocol only
  return out('other', real, 0);
}
