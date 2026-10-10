// FRONTEND: PnL summary of one scope without the rest of the portfolio view, for list rows (wallet
// and address cards show the ROI of the selected range).
import type { PnlSummary } from './api-types';
import { type QDb, nowSec } from './db';
import { loadFx } from './fx';
import { loadScopeHistory, pnlSummary } from './pnl';
import { loadTokens } from './state';
import { loadScopeYield, windowYield } from './yield';

export function getScopePnl(db: QDb, addressIds: number[], now = nowSec()): PnlSummary {
  const tokens = loadTokens(db);
  const history = loadScopeHistory(db, addressIds, tokens);
  const scopeYield = loadScopeYield(db, addressIds, history, tokens);
  return pnlSummary(history, now, {
    yieldIn: (from, to) => (scopeYield.pieces.length || scopeYield.gasKnown ? windowYield(scopeYield, from, to) : null),
    fx: loadFx(db),
  });
}
