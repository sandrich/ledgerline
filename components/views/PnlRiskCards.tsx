'use client';
// PnL by window with top contributors, and the risk & exposure card (leverage, LTV, rates,
// liquidation prices, net exposure, ATH / drawdown). Every field may be missing: render '-'.
import { useState } from 'react';
import type { LiquidationPoint, PnlSummary, PnlWindow, RiskSummary } from '../../lib/queries/api-types';
import { fmtMoney, fmtPct, fmtPrice, fmtShare, fmtUnits, fmtUtcDate } from '../format';
import { useApp } from '../layout/Providers';
import { pnlDisplay } from './pnl-display';
import { SignedPct } from './parts';

const WINDOWS: { key: PnlWindow; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y', label: '1y' },
  { key: 'all', label: 'All' },
];

/** tone for whole-dollar amounts (below $0.50 prints as 0) or, with eps, for fractions */
function signedTone(v: number | null | undefined, eps = 0.5): string {
  return v == null || Math.abs(v) < eps ? 'muted' : v < 0 ? 'neg' : 'pos';
}

export function PnlCard({
  pnl,
  className = 'card span-5',
  range,
  onRange,
}: {
  pnl?: PnlSummary | null;
  className?: string;
  /** controlled window, shared with the chart range pills */
  range?: PnlWindow;
  onRange?: (w: PnlWindow) => void;
}) {
  const { currency, rate } = useApp();
  const [own, setOwn] = useState<PnlWindow>('30d');
  const sel = range ?? own;
  const setSel = (w: PnlWindow) => (onRange ? onRange(w) : setOwn(w));
  // display values are already in the selected currency: rate 1
  const money = (v: number | null | undefined) => fmtMoney(v != null && Math.abs(v) < 0.5 ? 0 : v, currency, 1, { sign: true, decimals: 0 });
  const cur = pnl?.[sel];
  const d = pnlDisplay(cur, currency, rate);
  const fxMode = currency !== 'USD';
  const contrib = cur?.byAsset ?? [];
  const max = Math.max(...contrib.map((c) => Math.abs(c.pnlUsd)), 1);
  const selLabel = WINDOWS.find((w) => w.key === sel)?.label ?? sel;
  const hasYield = d != null && d.interest != null;

  return (
    <section className={`${className} pnl-card`} aria-labelledby="pnl-h">
      <div className="card-head">
        <h3 id="pnl-h">
          <i className="ph ph-chart-bar" aria-hidden="true" />
          PnL
        </h3>
        <span className="hint">{fxMode ? `in ${currency}, price and currency moves` : 'price moves on holdings'}</span>
      </div>
      {!pnl ? (
        <div className="empty slim">PnL is not available yet</div>
      ) : (
        <>
          <div className="pnl-scroll">
          <table className="pnl-table">
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col" className="r" title={fxMode ? `Price PnL plus the USD/${currency} effect` : 'Price moves on holdings'}>
                  PnL
                </th>
                {fxMode && (
                  <th scope="col" className="r" title={`Of the PnL: USD moving against ${currency} (net worth held x change of the rate)`}>
                    Currency
                  </th>
                )}
                <th scope="col" className="r" title="Return on invested capital in USD: PnL / (start value + net deposits)">
                  ROI
                </th>
                <th scope="col" className="r" title={hasYield ? 'Deposits and withdrawals' : 'Deposits, withdrawals, interest and fees'}>
                  Other
                </th>
              </tr>
            </thead>
            <tbody>
              {WINDOWS.map((w) => {
                const p = pnl[w.key];
                const pd = pnlDisplay(p, currency, rate);
                const on = w.key === sel;
                return (
                  <tr key={w.key} className={on ? 'on' : undefined} onClick={() => setSel(w.key)}>
                    <th scope="row">
                      <button type="button" aria-pressed={on} onClick={() => setSel(w.key)}>
                        {w.label}
                      </button>
                    </th>
                    <td className={`r num ${signedTone(pd?.pnl)}`}>{money(pd?.pnl)}</td>
                    {fxMode && <td className={`r num ${signedTone(pd?.fx)}`}>{money(pd?.fx)}</td>}
                    <td className={`r num ${signedTone(p?.returnPct, 0.00005)}`}>{fmtPct(p?.returnPct, 2)}</td>
                    <td className="r num dim">{money(pd?.other)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>

          {d && d.change != null && (
            <div className="pnl-parts">
              <h4>
                Where the change came from <span className="muted small">{selLabel}</span>
              </h4>
              <dl className="parts-dl">
                <div>
                  <dt>Market PnL</dt>
                  <dd className={`num ${signedTone(d.market)}`}>{money(d.market)}</dd>
                </div>
                {fxMode && (
                  <div>
                    <dt title={`USD gaining against ${currency} raises the ${currency} value of what you hold`}>Currency effect</dt>
                    <dd className={`num ${signedTone(d.fx)}`}>{d.fx != null ? money(d.fx) : '-'}</dd>
                  </div>
                )}
                <div>
                  <dt title={cur?.interestEstimated ? 'Estimated from rates' : 'Aave interest earned minus paid'}>Interest{cur?.interestEstimated ? ' (est.)' : ''}</dt>
                  <dd className={`num ${signedTone(d.interest)}`}>{d.interest != null ? money(d.interest) : '-'}</dd>
                </div>
                <div>
                  <dt>Gas</dt>
                  <dd className={`num ${d.gas != null && d.gas >= 0.5 ? 'neg' : 'muted'}`}>{d.gas != null ? money(-d.gas) : '-'}</dd>
                </div>
                <div>
                  <dt>{hasYield ? 'Deposits / withdrawals' : 'Deposits / other'}</dt>
                  <dd className="num dim">{money(d.other)}</dd>
                </div>
                <div className="parts-total">
                  <dt>Change</dt>
                  <dd className={`num ${signedTone(d.change)}`}>{money(d.change)}</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="pnl-contrib">
            <h4>
              Top contributors <span className="muted small">{selLabel}, price PnL</span>
            </h4>
            {!contrib.length ? (
              <div className="muted small">No price moves in this window</div>
            ) : (
              <ol className="contrib-list">
                {contrib.map((c) => (
                  <li key={c.asset}>
                    <span className="c-sym">{c.symbol}</span>
                    <span className="c-bar" aria-hidden="true">
                      <span className={c.pnlUsd < 0 ? 'neg' : 'pos'} style={{ width: `${(Math.abs(c.pnlUsd) / max) * 100}%` }} />
                    </span>
                    <span className={`c-val num ${signedTone(c.pnlUsd)}`}>{fmtMoney(Math.abs(c.pnlUsd) < 0.5 ? 0 : c.pnlUsd, currency, rate, { sign: true, decimals: 0 })}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <p className="footnote">
            PnL counts price moves on what you held{fxMode ? `, plus USD moving against ${currency}` : ''}. ROI is PnL over start value plus net deposits. Interest is Aave interest earned minus paid, gas
            what your addresses paid. Transfers between your own addresses are not profit.
          </p>
        </>
      )}
    </section>
  );
}

function liqTone(drop: number | null): string {
  if (drop == null) return 'ok';
  return drop < 0.15 ? 'danger' : drop < 0.3 ? 'warn' : 'ok';
}

function Stat({ label, value, sub, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {children}
      {sub != null && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export function RiskCard({
  risk,
  hasAave,
  hasDebt = false,
  netUsd,
  className = 'card span-7',
}: {
  risk?: RiskSummary | null;
  hasAave: boolean;
  /** Aave debt exists: missing LTV / liquidation data then means rates are not captured yet, not "no debt" */
  hasDebt?: boolean;
  netUsd?: number;
  className?: string;
}) {
  const { currency, rate } = useApp();
  const r = risk ?? null;
  const ltv = r?.ltvUsed ?? null;
  const liqs: LiquidationPoint[] = (r?.liquidations ?? []).slice().sort((a, b) => (a.dropPct ?? 9) - (b.dropPct ?? 9));
  const exposure = (r?.netExposure ?? []).filter((e) => Math.abs(e.usd) >= 1).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd));
  const main = r?.liquidation ?? liqs.find((l) => l.dropPct != null) ?? null;
  const maxExp = Math.max(...exposure.map((e) => Math.abs(e.usd)), 1);
  // net worth expressed in ETH (not an exposure): only when ETH is a meaningful part of the book
  const eth = exposure.find((e) => e.asset === 'ETH' && Math.abs(e.amount) > 1e-9);
  const ethPrice = eth ? eth.usd / eth.amount : null;
  const netEthRaw = netUsd != null && ethPrice != null && ethPrice > 0 ? netUsd / ethPrice : null;
  // only worth a line when debt or other assets make it differ from the ETH amount itself
  const netEth = netEthRaw != null && eth && Math.abs(netEthRaw - eth.amount) > Math.abs(eth.amount) * 0.02 ? netEthRaw : null;

  return (
    <section className={`${className} risk-card`} aria-labelledby="risk-h">
      <div className="card-head">
        <h3 id="risk-h">
          <i className="ph ph-shield-check" aria-hidden="true" />
          Risk &amp; exposure
        </h3>
        <span className="hint">at current prices and rates</span>
      </div>
      {!r ? (
        <div className="empty slim">Risk metrics are not available yet</div>
      ) : (
        <>
          <div className="stats">
            <Stat label="Leverage" value={r.leverage != null ? <span className="num">{r.leverage.toFixed(2)}x</span> : '-'} sub="assets / net worth" />
            <Stat label="LTV used" value={<span className="num">{fmtShare(ltv)}</span>} sub={ltv == null ? (hasDebt ? 'rates pending' : hasAave ? 'no debt' : 'no Aave positions') : 'of borrowing power'}>
              <span className={`stat-meter ltv-${ltv == null ? 'ok' : ltv > 0.85 ? 'danger' : ltv > 0.7 ? 'warn' : 'ok'}`} aria-hidden="true">
                <span style={{ width: `${Math.min(1, Math.max(0, ltv ?? 0)) * 100}%` }} />
              </span>
            </Stat>
            <Stat
              label="Net APY"
              value={<SignedPct f={r.netApy} />}
              sub={
                !hasAave ? (
                  'no Aave positions'
                ) : r.supplyApy == null && r.borrowApy == null ? (
                  'rates pending'
                ) : (
                <>
                  supply <span className="num">{fmtShare(r.supplyApy, 2)}</span>
                  <br />
                  borrow <span className="num">{fmtShare(r.borrowApy, 2)}</span>
                </>
                )
              }
            />
            <Stat label="Stablecoins" value={<span className="num">{fmtShare(r.stableShare)}</span>} sub="of gross assets" />
          </div>

          <div className="risk-cols">
            <div>
              <h4>Liquidation prices</h4>
              {!liqs.length ? (
                <div className="muted small">
                  {hasDebt ? 'Rates pending: liquidation prices appear after the next live scan' : hasAave ? 'No debt, nothing to liquidate' : 'No Aave positions'}
                </div>
              ) : (
                <table className="mini-table">
                  <thead>
                    <tr>
                      <th scope="col">Asset</th>
                      <th scope="col" className="r">
                        Price
                      </th>
                      <th scope="col" className="r">
                        Liq. price
                      </th>
                      <th scope="col" className="r">
                        Drop
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {liqs.map((l) => (
                      <tr key={`${l.addressId}-${l.market}-${l.asset}`}>
                        <th scope="row">{l.symbol}</th>
                        <td className="r num dim">{fmtPrice(l.price, currency, rate, 0)}</td>
                        <td className="r num">{l.liquidationPrice != null ? fmtPrice(l.liquidationPrice, currency, rate, 0) : '-'}</td>
                        <td className="r">
                          {l.dropPct != null ? <span className={`drop drop-${liqTone(l.dropPct)} num`}>{fmtPct(-l.dropPct, 0)}</span> : <span className="muted small">safe alone</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div>
              <h4>Net exposure</h4>
              {!exposure.length ? (
                <div className="muted small">No exposure</div>
              ) : (
                <ul className="exposure">
                  {exposure.map((e) => (
                    <li key={e.asset}>
                      <span className="x-sym">{e.symbol}</span>
                      <span className="x-amt num">{fmtUnits(e.amount)}</span>
                      <span className="x-bar" aria-hidden="true">
                        <span className={e.usd < 0 ? 'neg' : undefined} style={{ width: `${(Math.abs(e.usd) / maxExp) * 100}%` }} />
                      </span>
                      <span className="x-val num">{fmtMoney(e.usd, currency, rate, { compact: true })}</span>
                    </li>
                  ))}
                </ul>
              )}
              {netEth != null && (
                <div className="muted small x-note">
                  Net worth in ETH <span className="num">{fmtUnits(netEth)}</span>
                </div>
              )}
            </div>
          </div>
          {main && main.liquidationPrice != null && main.dropPct != null && main.price > 0 && (
            <div className={`liq-track liq-${liqTone(main.dropPct)}`}>
              <div className="lt-head">
                <span>
                  <b>{main.symbol}</b> can fall <b className="num">{fmtShare(main.dropPct, 0)}</b> before the position is liquidated
                </span>
                <span className="muted small">other assets held constant</span>
              </div>
              <div className="lt-bar" role="img" aria-label={`Liquidation at ${fmtPrice(main.liquidationPrice, currency, rate, 0)}, now ${fmtPrice(main.price, currency, rate, 0)}`}>
                <span className="lt-danger" style={{ width: `${Math.min(100, (main.liquidationPrice / main.price) * 100)}%` }} />
                <span className="lt-mark" style={{ left: `${Math.min(100, (main.liquidationPrice / main.price) * 100)}%` }}>
                  <i className="num">{fmtPrice(main.liquidationPrice, currency, rate, 0)}</i>
                </span>
                <span className="lt-now">
                  <i className="num">now {fmtPrice(main.price, currency, rate, 0)}</i>
                </span>
              </div>
            </div>
          )}
          <div className="card-foot">
            <span>
              All-time high <b>{r.ath ? fmtMoney(r.ath.usd, currency, rate, { decimals: 0 }) : '-'}</b>
              {r.ath ? (
                <>
                  {' '}
                  on <b>{fmtUtcDate(r.ath.ts)}</b>
                </>
              ) : null}
            </span>
            <span>
              Drawdown <b className={r.drawdownPct != null && r.drawdownPct < -0.0005 ? 'neg' : undefined}>{r.drawdownPct != null ? fmtPct(r.drawdownPct, 1) : '-'}</b>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
