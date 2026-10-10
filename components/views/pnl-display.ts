// One PnL window expressed in the display currency. In EUR / CHF the server already converted every
// part at the day's rate (PnlPeriod.currencies), so the parts add up exactly:
//   change = market + fx + interest - gas + other
// All values returned here are amounts of the display currency: format them with rate 1.
import type { PnlPeriod } from '../../lib/queries/api-types';
import type { Currency } from '../format';

export interface PnlDisplay {
  /** price PnL on holdings */
  market: number | null;
  /** currency effect (USD vs the display currency); null in USD */
  fx: number | null;
  /** market + fx: what the holdings earned measured in the display currency */
  pnl: number | null;
  /** net Aave interest, null when unknown (then it is inside other) */
  interest: number | null;
  /** gas, positive cost, null when unknown */
  gas: number | null;
  /** deposits / withdrawals (plus interest and gas when those are null) */
  other: number | null;
  change: number | null;
  /** true when the parts are exact per-day conversions (or USD) */
  exact: boolean;
}

export function pnlDisplay(p: PnlPeriod | null | undefined, cur: Currency, rate: number | null): PnlDisplay | null {
  if (!p) return null;
  if (cur === 'USD') {
    return {
      market: p.pnlUsd,
      fx: null,
      pnl: p.pnlUsd,
      interest: p.interestUsd ?? null,
      gas: p.gasUsd ?? null,
      other: p.otherUsd,
      change: p.changeUsd,
      exact: true,
    };
  }
  const c = p.currencies?.[cur];
  if (c) {
    return { market: c.market, fx: c.fxEffect, pnl: c.market + c.fxEffect, interest: c.interest, gas: c.gas, other: c.other, change: c.change, exact: true };
  }
  // older server: convert at the latest rate, no currency split
  const r = rate ?? 1;
  const m = (v: number | null | undefined) => (v == null ? null : v * r);
  return { market: m(p.pnlUsd), fx: null, pnl: m(p.pnlUsd), interest: m(p.interestUsd), gas: m(p.gasUsd), other: m(p.otherUsd), change: m(p.changeUsd), exact: false };
}
