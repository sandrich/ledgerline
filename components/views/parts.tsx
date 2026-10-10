'use client';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { AaveSummary, BackfillProgress, Breakdown, Change, FlowSummary, JobsResponse, LiquidationPoint, PnlPeriod, PnlSummary, PnlWindow, RiskSummary, Totals, TopToken } from '../../lib/queries/api-types';
import {
  CHAIN_COLOR,
  CHAIN_LABEL,
  MARKET_LABEL,
  MASK,
  fmtAmount,
  fmtDate,
  fmtHf,
  fmtMoney,
  fmtNumber,
  fmtPct,
  fmtPrice,
  fmtShare,
  fmtUtcDate,
  groupSwiss,
  hfFill,
  hfTone,
  moneyParts,
  shortAddr,
} from '../format';
import { useApi, useApp } from '../layout/Providers';

export function Hero({ eyebrow, title, em, sub, right }: { eyebrow: string; title: ReactNode; em: string; sub: ReactNode; right?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">
          <span className="dot" />
          {eyebrow}
        </div>
        <h1>
          {title} <em>{em}</em>
        </h1>
        <p className="sub">{sub}</p>
      </div>
      {right && <div className="head-actions">{right}</div>}
    </div>
  );
}

export function Money({ usd, decimals, sign }: { usd: number | null | undefined; decimals?: number; sign?: boolean }) {
  const { currency, rate } = useApp();
  return <span className="num">{fmtMoney(usd, currency, rate, { decimals, sign })}</span>;
}

export function ChangeText({ c }: { c: Change | null | undefined }) {
  const { currency, rate } = useApp();
  if (!c || c.abs == null) return <span className="muted">-</span>;
  const neg = c.abs < 0;
  return (
    <span className={neg ? 'neg' : 'pos'}>
      <span className="num">{fmtMoney(c.abs, currency, rate, { sign: true, decimals: 0 })}</span>
      {c.pct != null && <span className="num"> {fmtPct(c.pct)}</span>}
    </span>
  );
}

function BigMoney({ usd }: { usd: number }) {
  const { currency, rate, stealth } = useApp();
  const p = moneyParts(usd, currency, rate);
  return (
    <span className={stealth ? 'masked' : undefined}>
      <small className="pre">{p.prefix.trim()}</small>
      {p.body}
      {p.suffix && <small>{p.suffix}</small>}
    </span>
  );
}

/** Signed money for KPI values: "+$4'402" with the currency in small type, compact above 100k. */
export function BigSigned({ usd }: { usd: number }) {
  const { currency, rate, stealth } = useApp();
  if (stealth) {
    return (
      <span className="masked">
        <small className="pre">{currency === 'CHF' ? 'CHF' : '$'}</small>
        {MASK}
      </span>
    );
  }
  const v = currency === 'CHF' && rate ? usd * rate : usd;
  const abs = Math.abs(v);
  const zero = abs < 0.5; // rounds to 0: no sign, no color
  const sign = zero ? '' : v < 0 ? '-' : '+';
  const body = abs >= 1e6 ? `${groupSwiss((abs / 1e6).toFixed(2))}M` : abs >= 1e5 ? `${groupSwiss((abs / 1e3).toFixed(1))}k` : groupSwiss(abs.toFixed(0));
  return (
    <span className={zero ? undefined : v < 0 ? 'neg' : 'pos'}>
      {sign}
      <small className="pre">{currency === 'CHF' ? 'CHF' : '$'}</small>
      {body}
      {currency === 'CHF' && abs < 1e5 && <small>.-</small>}
    </span>
  );
}

/** Signed percentage for KPI values: "+1.27%" with a small percent sign. */
export function BigPct({ f, tone = true }: { f: number; tone?: boolean }) {
  const p = f * 100;
  return (
    <span className={tone ? (p < 0 ? 'neg' : 'pos') : undefined}>
      {p > 0 ? '+' : ''}
      {p.toFixed(Math.abs(p) >= 100 ? 0 : 2)}
      <small>%</small>
    </span>
  );
}

export function SignedPct({ f, decimals = 2 }: { f: number | null | undefined; decimals?: number }) {
  if (f == null || !Number.isFinite(f)) return <span className="muted">-</span>;
  return <span className={`num ${f < 0 ? 'neg' : 'pos'}`}>{fmtPct(f, decimals)}</span>;
}

export const RANGE_TEXT: Record<PnlWindow, { short: string; long: string }> = {
  '24h': { short: '24h', long: 'in the last 24h' },
  '7d': { short: '7d', long: 'over the last 7 days' },
  '30d': { short: '30d', long: 'over the last 30 days' },
  '90d': { short: '90d', long: 'over the last 90 days' },
  '1y': { short: '1y', long: 'over the last year' },
  all: { short: 'all time', long: 'since the start of the history' },
};

function PnlKpi({ label, icon, p, since, pending, extra }: { label: string; icon: string; p: PnlPeriod | null | undefined; since?: boolean; pending?: boolean; extra?: ReactNode }) {
  const has = p != null && p.pnlUsd != null;
  return (
    <div className="kpi" role="listitem">
      <div className="label">
        <i className={`ph ${icon}`} aria-hidden="true" />
        {label}
      </div>
      <div className="value fit">{has ? <BigSigned usd={p.pnlUsd!} /> : '-'}</div>
      <div className="sub">
        {!has ? (
          pending ? 'PnL pending' : 'not enough history yet'
        ) : (
          <>
            {p.returnPct != null ? (
              <>
                <SignedPct f={p.returnPct} /> ROI
              </>
            ) : (
              'ROI n/a'
            )}
            {since && p.fromTs != null ? `, since ${fmtUtcDate(p.fromTs)}` : ''}
            {extra}
          </>
        )}
      </div>
    </div>
  );
}

/** Most critical liquidation point (smallest drop) of a list, null when none is liquidatable. */
export function mainLiquidation(list: LiquidationPoint[] | null | undefined): LiquidationPoint | null {
  let best: LiquidationPoint | null = null;
  for (const l of list ?? []) if (l.dropPct != null && (best == null || l.dropPct < best.dropPct!)) best = l;
  return best;
}

export function KpiStrip({
  totals,
  aave,
  pnl,
  risk,
  range = '30d',
  flows,
  walletScope = false,
}: {
  totals: Totals;
  aave: AaveSummary;
  pnl?: PnlSummary | null;
  risk?: RiskSummary | null;
  /** the selected chart range, drives the PnL and change cards */
  range?: PnlWindow;
  flows?: FlowSummary | null;
  /** wallet scope: transfers from other own wallets count as deposits */
  walletScope?: boolean;
}) {
  const { currency, rate } = useApp();
  const hf = aave.lowestHealthFactor;
  const hasAave = aave.suppliedUsd > 0 || aave.borrowedUsd > 0;
  const hasDebt = aave.borrowedUsd > 0;
  const tone = hfTone(hasDebt ? hf : null);
  const liq = risk?.liquidation ?? mainLiquidation(risk?.liquidations);
  const netApy = risk?.netApy ?? null;
  const yieldUsd = risk?.annualYieldUsd ?? null;
  const sel = pnl?.[range] ?? null;
  const day = pnl?.['24h'] ?? null;
  const rt = RANGE_TEXT[range];
  const signed = (v: number | null | undefined) => fmtMoney(v != null && Math.abs(v) < 0.5 ? 0 : v, currency, rate, { sign: true, decimals: 0, compact: true });
  const depositsTitle = walletScope ? 'Net deposits into this wallet, transfers from your other wallets included' : 'External deposits minus withdrawals, transfers between your own addresses excluded';
  return (
    <div className="kpis" role="list">
      <div className="kpi" role="listitem">
        <div className="label">
          <i className="ph ph-coins" aria-hidden="true" />
          Net worth
        </div>
        <div className="value fit">
          <BigMoney usd={totals.netUsd} />
        </div>
        <div className="sub sub-lines">
          <span>
            assets {fmtMoney(totals.assetsUsd, currency, rate, { compact: true })}, debt {fmtMoney(totals.debtUsd, currency, rate, { compact: true })}
          </span>
          {day && day.pnlUsd != null && (
            <span>
              24h <span className={`num ${day.pnlUsd < -0.5 ? 'neg' : day.pnlUsd > 0.5 ? 'pos' : ''}`}>{signed(day.pnlUsd)}</span>
              {day.returnPct != null && (
                <>
                  {' '}
                  <SignedPct f={day.returnPct} />
                </>
              )}
            </span>
          )}
        </div>
      </div>
      <PnlKpi label={`PnL (${rt.short})`} icon="ph-chart-line-up" p={sel} pending={!pnl} />
      <div className="kpi" role="listitem">
        <div className="label">
          <i className="ph ph-arrows-down-up" aria-hidden="true" />
          Change ({rt.short})
        </div>
        <div className="value fit">{sel?.changeUsd != null ? <BigSigned usd={sel.changeUsd} /> : '-'}</div>
        <div className="sub sub-lines">
          {sel?.changeUsd == null ? (
            <span>{pnl ? 'not enough history yet' : 'pending'}</span>
          ) : (
            <>
              <span title="Price moves on what you held">
                PnL <span className={`num ${(sel.pnlUsd ?? 0) < -0.5 ? 'neg' : (sel.pnlUsd ?? 0) > 0.5 ? 'pos' : ''}`}>{signed(sel.pnlUsd)}</span>
              </span>
              <span title="Deposits, withdrawals, Aave interest and fees">
                deposits / other <span className="num">{signed(sel.otherUsd)}</span>
              </span>
            </>
          )}
        </div>
      </div>
      {range === 'all' && flows ? (
        <div className="kpi" role="listitem" title={depositsTitle}>
          <div className="label">
            <i className="ph ph-hand-coins" aria-hidden="true" />
            Net deposits
          </div>
          <div className="value fit">
            <BigMoney usd={flows.netDepositsUsd} />
          </div>
          <div className="sub sub-lines">
            <span>
              in {fmtMoney(flows.depositsUsd, currency, rate, { compact: true })}, out {fmtMoney(flows.withdrawalsUsd, currency, rate, { compact: true })}
            </span>
            {flows.sinceTs != null && <span>since {fmtUtcDate(flows.sinceTs)}</span>}
          </div>
        </div>
      ) : (
        <PnlKpi
          label="All-time PnL"
          icon="ph-infinity"
          p={pnl?.all}
          pending={!pnl}
          extra={
            flows ? (
              <span className="sub-line" title={depositsTitle}>
                net deposits {fmtMoney(flows.netDepositsUsd, currency, rate, { compact: true })}
              </span>
            ) : (
              pnl?.all.fromTs != null && <span className="sub-line">since {fmtUtcDate(pnl.all.fromTs)}</span>
            )
          }
        />
      )}
      <div className={`kpi hf-${tone}`} role="listitem">
        <div className="label">
          <i className="ph ph-heartbeat" aria-hidden="true" />
          Health factor
        </div>
        <div className="value fit">{hasAave ? fmtHf(hf, hasDebt) : '-'}</div>
        <div className="meter" role="meter" aria-valuemin={1} aria-valuemax={3} aria-valuenow={hf ?? 3} aria-label="Health factor">
          <span style={{ width: `${hasAave ? hfFill(hf) * 100 : 0}%` }} />
        </div>
        <div className="sub">
          {!hasAave
            ? 'no Aave positions'
            : !hasDebt
              ? 'no debt, cannot be liquidated'
              : liq && liq.liquidationPrice != null && liq.dropPct != null
                ? `liquidation at ${liq.symbol} ${fmtPrice(liq.liquidationPrice, currency, rate, 0)}, ${fmtPct(-liq.dropPct, 0)}`
                : 'liquidation price unknown'}
        </div>
      </div>
      <div className="kpi" role="listitem">
        <div className="label">
          <i className="ph ph-percent" aria-hidden="true" />
          Net APY
        </div>
        <div className="value fit">{hasAave && netApy != null ? <BigPct f={netApy} /> : '-'}</div>
        <div className="sub">
          {!hasAave ? (
            'no Aave positions'
          ) : yieldUsd != null ? (
            <>
              <span className={`num ${yieldUsd < 0 ? 'neg' : 'pos'}`}>{fmtMoney(yieldUsd, currency, rate, { sign: true, decimals: 0 })}</span> / year on Aave equity
            </>
          ) : (
            'on Aave equity, rates pending'
          )}
        </div>
      </div>
    </div>
  );
}

/** Banner while history is being backfilled: depth, progress, and any planning error. */
export function BackfillBanner({ addressIds }: { addressIds?: number[] | null }) {
  const { data } = useApi<JobsResponse>('/api/jobs', { pollMs: 10_000 });
  if (!data) return null;
  const rows = data.addresses.filter((a) => !addressIds || addressIds.includes(a.id));
  const done = rows.reduce((s, a) => s + a.backfill.doneDays, 0);
  const total = rows.reduce((s, a) => s + a.backfill.totalDays, 0);
  const errors = rows.filter((a) => a.backfill.error);
  const running = data.summary.active.some((j) => j.type === 'backfill' || j.type === 'discovery');
  if (total === 0 && !errors.length && !running) return null;
  if (done >= total && !errors.length) return null;
  const start = rows.map((a) => a.backfill.startTs).filter((t): t is number => t != null);
  const from = start.length ? Math.min(...start) : null;
  const pct = total > 0 ? done / total : 0;
  return (
    <div className={`banner${errors.length ? ' warn' : ''}`} role="status">
      <span className="spin" aria-hidden="true" />
      <div className="banner-main">
        <b>{total > 0 ? 'Backfilling history' : 'Looking for first on-chain activity'}</b>
        <span>
          {from != null ? `History from ${fmtDate(from)} (first activity), ` : ''}
          {total > 0 ? `${fmtNumber(done)} of ${fmtNumber(total)} days` : 'scanning transfers'}
          {errors.length ? `. ${errors.map((e) => `${e.label ?? shortAddr(e.address)}: ${e.backfill.error}`).join('; ')}` : ''}
        </span>
      </div>
      {total > 0 && (
        <div className="banner-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)}>
          <span style={{ width: `${pct * 100}%` }} />
        </div>
      )}
      <span className="num banner-pct">{Math.floor(pct * 100)}%</span>
    </div>
  );
}

export function BarList({ items, colorOf, empty }: { items: Breakdown[]; colorOf?: (key: string, i: number) => string; empty: string }) {
  const { currency, rate } = useApp();
  const shown = items.filter((b) => Math.abs(b.usd) >= 0.005);
  if (!shown.length) return <div className="empty slim">{empty}</div>;
  const max = Math.max(...shown.map((b) => Math.abs(b.usd)), 1);
  return (
    <ul className="barlist">
      {shown.map((b, i) => (
        <li key={b.key}>
          <div className="bl-top">
            <span className="bl-label">
              <i className="sw" style={{ background: colorOf?.(b.key, i) ?? 'var(--oc)' }} />
              {b.label}
            </span>
            <span className="num bl-val">{fmtMoney(b.usd, currency, rate)}</span>
            <span className="num bl-share">{b.share >= 0 ? `${(b.share * 100).toFixed(1)}%` : '-'}</span>
          </div>
          <div className="rank-bar">
            <span style={{ width: `${(Math.abs(b.usd) / max) * 100}%`, ['--c' as string]: b.usd < 0 ? 'var(--c5)' : (colorOf?.(b.key, i) ?? 'var(--oc)') }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function chainColor(key: string): string {
  return CHAIN_COLOR[key] ?? 'var(--neutral)';
}

export function protocolColor(key: string): string {
  return key === 'aave-v3' ? 'var(--ccr)' : key === 'wallet' ? 'var(--oc)' : 'var(--tag)';
}

/**
 * Top holdings card body: what is owned (wallet + supplied, gross) ranked by value with the share of
 * gross assets, balances under $1 folded away, then a Borrowed section, then Assets - Borrowed = Net.
 */
export function TopHoldings({ tokens, totals }: { tokens: TopToken[]; totals: Totals }) {
  const { currency, rate } = useApp();
  const [showSmall, setShowSmall] = useState(false);
  const owned = tokens
    .map((t) => ({ t, usd: t.walletUsd + t.suppliedUsd, amount: t.heldAmount ?? Math.max(0, t.amount) }))
    .filter((r) => r.usd > 0.005)
    .sort((a, b) => b.usd - a.usd);
  const big = owned.filter((r) => r.usd >= 1).slice(0, 10);
  const small = owned.filter((r) => !big.includes(r));
  const borrowed = tokens
    .filter((t) => t.borrowedUsd > 0.005)
    .map((t) => ({ t, usd: t.borrowedUsd, amount: t.borrowedAmount ?? Math.max(0, -t.amount) }))
    .sort((a, b) => b.usd - a.usd);
  if (!owned.length && !borrowed.length) return <div className="empty slim">No holdings yet</div>;
  const gross = totals.assetsUsd > 0 ? totals.assetsUsd : owned.reduce((s, r) => s + r.usd, 0);
  const max = Math.max(...owned.map((r) => r.usd), ...borrowed.map((r) => r.usd), 1);
  const shown = showSmall ? [...big, ...small] : big;
  const smallUsd = small.reduce((s, r) => s + r.usd, 0);
  const money = (v: number) => fmtMoney(v, currency, rate, { compact: true });

  return (
    <div className="holdings-wrap">
      <ol className="rank holdings">
        {shown.map((r, i) => (
          <li key={r.t.key} className="rank-row" title={r.t.name ?? r.t.symbol}>
            <span className="rank-i">{String(i + 1).padStart(2, '0')}</span>
            <span className="rank-label">
              {r.t.symbol}
              <small className="muted"> {fmtAmount(r.amount)}</small>
            </span>
            <span className="rank-bar">
              <span style={{ width: `${(r.usd / max) * 100}%`, ['--c' as string]: i === 0 ? 'var(--accent)' : 'var(--oc)' }} />
            </span>
            <span className="rank-val">
              {money(r.usd)}
              <small className="rank-share">{fmtShare(gross > 0 ? r.usd / gross : null)}</small>
            </span>
          </li>
        ))}
      </ol>
      {small.length > 0 && (
        <button type="button" className="small-toggle" aria-expanded={showSmall} onClick={() => setShowSmall((v) => !v)}>
          <i className={`ph ${showSmall ? 'ph-caret-up' : 'ph-caret-down'}`} aria-hidden="true" />
          {showSmall ? 'Hide' : ''} {small.length} small balance{small.length === 1 ? '' : 's'}
          <span className="num muted">{money(smallUsd)}</span>
        </button>
      )}
      {borrowed.length > 0 && (
        <>
          <h4 className="borrowed-head">
            Borrowed <span className="muted small">debt on Aave</span>
          </h4>
          <ol className="rank holdings borrowed">
            {borrowed.map((r) => (
              <li key={r.t.key} className="rank-row" title={`${r.t.symbol} borrowed`}>
                <span className="rank-i">
                  <i className="ph ph-arrow-bend-down-left" aria-hidden="true" />
                </span>
                <span className="rank-label">
                  {r.t.symbol}
                  <small className="muted"> {fmtAmount(r.amount)}</small>
                </span>
                <span className="rank-bar">
                  <span style={{ width: `${(r.usd / max) * 100}%`, ['--c' as string]: 'var(--c5)' }} />
                </span>
                <span className="rank-val neg">
                  {money(-r.usd)}
                  <small className="rank-share">{r.t.borrowApy != null ? `${fmtShare(r.t.borrowApy, 2)} APY` : 'APY -'}</small>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="holdings-total" aria-label="Assets minus borrowed equals net worth">
        <span>
          <small>Assets</small>
          <b className="num">{money(totals.assetsUsd)}</b>
        </span>
        <span className="op" aria-hidden="true">
          -
        </span>
        <span>
          <small>Borrowed</small>
          <b className="num neg">{money(totals.debtUsd)}</b>
        </span>
        <span className="op" aria-hidden="true">
          =
        </span>
        <span>
          <small>Net worth</small>
          <b className="num">{money(totals.netUsd)}</b>
        </span>
      </div>
    </div>
  );
}

export function HfMeter({ hf, hasDebt }: { hf: number | null; hasDebt: boolean }) {
  const tone = hfTone(hasDebt ? hf : null);
  return (
    <span className={`hf hf-${tone}`}>
      <span className="hf-val num">{fmtHf(hf, hasDebt)}</span>
      <span className="hf-meter" aria-hidden="true">
        <span style={{ width: `${hfFill(hasDebt ? hf : null) * 100}%` }} />
      </span>
    </span>
  );
}

export function AaveCard({ aave, className = 'card span-4' }: { aave: AaveSummary; className?: string }) {
  const { currency, rate } = useApp();
  return (
    <section className={className}>
      <div className="card-head">
        <h3>
          <i className="ph ph-bank" aria-hidden="true" />
          Aave positions
        </h3>
        <span className="hint">health factor</span>
      </div>
      {!aave.positions.length ? (
        <div className="empty slim">No open Aave V3 positions</div>
      ) : (
        <ul className="aave-list">
          {aave.positions.map((p) => (
            <li key={`${p.addressId}-${p.market}`}>
              <Link href={`/address/${p.address}`} className="aave-row">
                <div className="aave-main">
                  <b>{MARKET_LABEL[p.market] ?? p.market}</b>
                  <span className="muted small">
                    {p.label ?? shortAddr(p.address)}, {CHAIN_LABEL[p.chain] ?? p.chain}
                  </span>
                </div>
                <HfMeter hf={p.healthFactor} hasDebt={p.borrowedUsd > 0} />
                <div className="aave-nums">
                  <span>
                    <span className="muted">Supplied</span> <span className="num">{fmtMoney(p.suppliedUsd, currency, rate)}</span>
                  </span>
                  <span>
                    <span className="muted">Borrowed</span> <span className="num">{fmtMoney(p.borrowedUsd, currency, rate)}</span>
                  </span>
                  <span>
                    <span className="muted">Net</span> <b className="num">{fmtMoney(p.netUsd, currency, rate)}</b>
                  </span>
                  {p.netApy != null && (
                    <span>
                      <span className="muted">Net APY</span> <SignedPct f={p.netApy} />
                    </span>
                  )}
                </div>
                {(() => {
                  const l = p.borrowedUsd > 0 ? mainLiquidation(p.liquidations) : null;
                  if (!l || l.dropPct == null) return null;
                  return (
                    <div className={`aave-liq liq-${l.dropPct < 0.15 ? 'danger' : l.dropPct < 0.3 ? 'warn' : 'ok'}`}>
                      <i className="ph ph-warning-diamond" aria-hidden="true" />
                      <span>
                        Liquidation if {l.symbol} falls <b className="num">{fmtShare(l.dropPct, 0)}</b> to{' '}
                        <b className="num">{fmtPrice(l.liquidationPrice, currency, rate, 0)}</b>
                      </span>
                    </div>
                  );
                })()}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card span-12 card-error big" role="alert">
      <i className="ph ph-warning-circle" aria-hidden="true" />
      <div>
        <b>Something went wrong</b>
        <span>{message}</span>
      </div>
      {onRetry && (
        <button className="btn" type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="loading" aria-busy="true" aria-label="Loading">
      <div className="skeleton sk-title" />
      <div className="skeleton sk-strip" />
      <div className="sk-grid">
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    </div>
  );
}

export function backfillText(b: BackfillProgress): string {
  if (b.error) return b.error;
  if (b.totalDays === 0) return b.startTs ? `History from ${fmtDate(b.startTs)}` : 'Waiting for first scan';
  const from = b.startTs ? `History from ${fmtDate(b.startTs)} (first activity), ` : '';
  return `${from}${fmtNumber(b.doneDays)} of ${fmtNumber(b.totalDays)} days`;
}
