'use client';
// Overview (/) and wallet view (/wallets/[id]): hero, KPI strip, history chart with a side list,
// allocation by chain / protocol, top holdings, Aave positions.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { FlowSummary, GroupBy, HistoryRange, OverviewResponse, PnlPeriod, ScopePnlResponse, WalletDetailResponse } from '../../lib/queries/api-types';
import { HistoryCard, RANGES, RangePills } from '../charts/HistoryCard';
import { Sparkline, useScopeHistory } from '../charts/Sparkline';
import { fmtMoney, fmtPct, fmtShare, fmtUtcDate, shortAddr, type Currency } from '../format';
import { useApi, useApp } from '../layout/Providers';
import { RecentActivity } from '../tx/TxList';
import { PnlCard, RiskCard } from './PnlRiskCards';
import { pnlDisplay } from './pnl-display';
import { CurrencyCard, RatesCard, SuggestionsBanner, YieldCard, useRates, useYield } from './YieldCards';
import { AaveCard, BackfillBanner, BarList, ErrorCard, Hero, KpiStrip, PageSkeleton, RANGE_TEXT, TopHoldings, chainColor, protocolColor } from './parts';

/** Selected range, shared by the chart, the KPI strip and the PnL card; remembered per scope. */
export function useScopeRange(scope: string, fallback: HistoryRange): [HistoryRange, (r: HistoryRange) => void] {
  const key = `portfolio.range.${scope}`;
  // the view renders a skeleton on the server (data loads client side), so reading storage here
  // cannot cause a hydration mismatch in visible output
  const [range, setState] = useState<HistoryRange>(() => {
    try {
      const v = typeof window !== 'undefined' ? localStorage.getItem(key) : null;
      if (v && RANGES.some((r) => r.key === v)) return v as HistoryRange;
    } catch {
      /* storage unavailable */
    }
    return fallback;
  });
  const set = (r: HistoryRange) => {
    setState(r);
    try {
      localStorage.setItem(key, r);
    } catch {
      /* ignore */
    }
  };
  return [range, set];
}

/** One list row in the side card: badge, name, sparkline for the selected range, value and change. */
function ScopeRow({
  href,
  scope,
  range,
  color,
  badge,
  name,
  meta,
  usd,
}: {
  href: string;
  scope: string;
  range: HistoryRange;
  color: string;
  badge: string;
  name: string;
  meta: ReactNode;
  usd: number;
}) {
  const { currency, rate } = useApp();
  const { points, pct } = useScopeHistory(scope, range);
  // ROI of the range (price PnL over invested capital), not the value change: deposits are not gains
  const { data: pnl } = useApi<ScopePnlResponse>(`/api/pnl?scope=${encodeURIComponent(scope)}`);
  const roi = pnl?.pnl[range]?.returnPct ?? null;
  return (
    <Link href={href}>
      <span className="r-date badge" style={{ ['--bc' as string]: color }}>
        <b>{badge}</b>
      </span>
      <span className="r-main">
        <span className="r-place">{name}</span>
        <span className="r-meta">{meta}</span>
      </span>
      <span className="r-spark">
        <Sparkline values={points.map((p) => p.total)} color={pct != null && pct < 0 ? 'var(--warn)' : color} />
      </span>
      <span className="r-depth">
        {fmtMoney(usd, currency, rate, { decimals: 0 })}
        <small className={roi == null ? 'muted' : roi < 0 ? 'neg' : 'pos'} title={`PnL return on invested capital ${RANGE_TEXT[range].long} (deposits and withdrawals do not count)`}>
          {roi != null ? `${fmtPct(roi)} ROI` : '-'}
        </small>
      </span>
    </Link>
  );
}

function FlowsBlock({ flows, walletScope, scope }: { flows: FlowSummary; walletScope: boolean; scope: string }) {
  const { currency, rate } = useApp();
  return (
    <div className="flows-block">
      <div className="card-head sub-head">
        <h3>
          <i className="ph ph-hand-coins" aria-hidden="true" />
          {walletScope ? 'Money in and out' : 'Deposits'}
        </h3>
        <Link className="link" href={scope === 'all' ? '/transactions' : `/transactions?scope=${encodeURIComponent(scope)}`}>
          Activity <i className="ph ph-arrow-right" aria-hidden="true" />
        </Link>
      </div>
      <dl className="flows-dl">
        <div>
          <dt>Deposited</dt>
          <dd className="num pos">{fmtMoney(flows.depositsUsd, currency, rate, { compact: true })}</dd>
        </div>
        <div>
          <dt>Withdrawn</dt>
          <dd className="num neg">{fmtMoney(flows.withdrawalsUsd, currency, rate, { compact: true })}</dd>
        </div>
        <div>
          <dt>Net</dt>
          <dd className="num">{fmtMoney(flows.netDepositsUsd, currency, rate, { compact: true, sign: true })}</dd>
        </div>
      </dl>
      <p className="footnote">
        Valued at the time{flows.sinceTs != null ? `, since ${fmtUtcDate(flows.sinceTs)}` : ''}.{' '}
        {walletScope ? 'Transfers with your other wallets count here.' : 'Moves between your own addresses are excluded, so they never show as gains.'}
      </p>
    </div>
  );
}

function heroPnl(p: PnlPeriod | null | undefined, range: HistoryRange, currency: Currency, rate: number | null, stealth: boolean): string {
  if (!p || p.pnlUsd == null) return '';
  if (stealth) return p.returnPct != null ? `${fmtPct(p.returnPct)} ROI ${RANGE_TEXT[range].long}.` : '';
  const roi = p.returnPct != null ? ` (${fmtPct(p.returnPct)} ROI)` : '';
  const d = pnlDisplay(p, currency, rate);
  return `${fmtMoney(d?.pnl ?? null, currency, 1, { sign: true, compact: true })} PnL${roi} ${RANGE_TEXT[range].long}.`;
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/);
  return ((w[0]?.[0] ?? '') + (w[1]?.[0] ?? w[0]?.[1] ?? '')).toUpperCase();
}

export function PortfolioView({ walletId }: { walletId?: number }) {
  const url = walletId != null ? `/api/wallets/${walletId}` : '/api/overview';
  const { data, error, loading, reload } = useApi<OverviewResponse | WalletDetailResponse>(url, { pollMs: 60_000 });
  const { currency, rate, stealth } = useApp();
  const scopeKey = walletId != null ? `wallet:${walletId}` : 'all';
  const [range, setRange] = useScopeRange(scopeKey, '30d');
  const yieldSel = useYield(scopeKey, range);
  const yield30 = useYield(scopeKey, '30d');
  const { data: rates } = useRates(scopeKey, range);
  const [ratesOpen, setRatesOpen] = useState(false);

  if (loading) return <PageSkeleton />;
  if (error && !data) return <ErrorCard message={error} onRetry={reload} />;
  if (!data) return null;
  const wallet = 'wallet' in data ? (data as WalletDetailResponse).wallet : null;
  const addresses = 'addresses' in data ? (data as WalletDetailResponse).addresses : null;

  if (!wallet && data.byWallet.length === 0) {
    return (
      <div className="onboarding card span-12">
        <div className="eyebrow">
          <span className="dot" />
          Welcome
        </div>
        <h1>
          Track your on-chain <em>net worth</em>
        </h1>
        <p className="sub">
          Create a wallet, add one or more Ethereum or Arbitrum addresses, and the worker scans balances, Aave V3 positions and the full daily history back to each
          address&apos;s first on-chain activity.
        </p>
        <Link className="btn btn-primary" href="/wallets?new=1">
          <i className="ph ph-plus" aria-hidden="true" />
          Add wallet
        </Link>
      </div>
    );
  }

  const scope = wallet ? `wallet:${wallet.id}` : 'all';
  const top = data.topTokens.slice().sort((a, b) => b.walletUsd + b.suppliedUsd - (a.walletUsd + a.suppliedUsd))[0];
  const chainsWithValue = data.byChain.filter((c) => Math.abs(c.usd) >= 0.01);
  const groups: GroupBy[] = wallet ? ['none', 'chain', 'protocol'] : ['none', 'chain', 'wallet', 'protocol'];
  const activeWallets = data.byWallet.filter((w) => !w.excluded).length;
  const defaultGroup: GroupBy = !wallet && activeWallets > 1 ? 'wallet' : 'none';
  const hasAave = data.aave.suppliedUsd > 0 || data.aave.borrowedUsd > 0;
  const nAddr = addresses?.length ?? data.byWallet.reduce((s, w) => s + w.addressCount, 0);

  return (
    <div className="view">
      {wallet && (
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/wallets">
            <i className="ph ph-wallet" aria-hidden="true" />
            Wallets
          </Link>
          <i className="ph ph-caret-right" aria-hidden="true" />
          <span>{wallet.name}</span>
        </nav>
      )}
      <Hero
        eyebrow={wallet ? 'Wallet' : 'Overview'}
        title={wallet ? wallet.name : 'Net worth,'}
        em={wallet ? 'over time' : 'over time'}
        sub={
          <>
            {stealth ? 'Across' : `${fmtMoney(data.totals.netUsd, currency, rate)} across`} {nAddr} address{nAddr === 1 ? '' : 'es'}
            {chainsWithValue.length ? ` on ${chainsWithValue.map((c) => c.label).join(' and ')}` : ''}
            {top
              ? stealth
                ? `, largest holding ${top.symbol} at ${fmtShare(data.totals.assetsUsd > 0 ? (top.walletUsd + top.suppliedUsd) / data.totals.assetsUsd : null, 0)} of assets`
                : `, largest holding ${top.symbol} at ${fmtMoney(top.walletUsd + top.suppliedUsd, currency, rate, { compact: true })}`
              : ''}
            .{' '}
            {heroPnl(data.pnl?.[range], range, currency, rate, stealth)}
          </>
        }
        right={<RangePills value={range} onChange={setRange} />}
      />
      <BackfillBanner addressIds={addresses ? addresses.map((a) => a.id) : null} />
      <SuggestionsBanner walletId={wallet?.id} />
      <KpiStrip
        totals={data.totals}
        aave={data.aave}
        pnl={data.pnl}
        risk={data.risk}
        range={range}
        flows={data.flows}
        walletScope={!!wallet}
        yield30={range === '30d' ? yieldSel.data : yield30.data}
      />

      <div className="bento">
        <HistoryCard scope={scope} range={range} groups={groups} defaultGroup={defaultGroup} />
        <section className="card span-4">
          <div className="card-head">
            <h3>
              <i className={`ph ${wallet ? 'ph-list-bullets' : 'ph-wallet'}`} aria-hidden="true" />
              {wallet ? 'Addresses' : 'Wallets'}
            </h3>
            <Link className="link" href="/wallets">
              Manage <i className="ph ph-arrow-right" aria-hidden="true" />
            </Link>
          </div>
          <div className="recent with-spark">
            {wallet
              ? addresses!.map((a) => (
                  <ScopeRow
                    key={a.id}
                    href={`/address/${a.address}`}
                    scope={`address:${a.address}`}
                    range={range}
                    color={wallet.color ?? 'var(--accent)'}
                    badge={(a.label ?? a.address.slice(2, 4)).slice(0, 2).toUpperCase()}
                    name={a.label ?? shortAddr(a.address)}
                    meta={
                      <>
                        <span className="num">{shortAddr(a.address)}</span>
                        {a.excluded && <span className="pill">excluded</span>}
                      </>
                    }
                    usd={a.usd}
                  />
                ))
              : data.byWallet.map((w) => (
                  <ScopeRow
                    key={w.id}
                    href={`/wallets/${w.id}`}
                    scope={`wallet:${w.id}`}
                    range={range}
                    color={w.color ?? 'var(--accent)'}
                    badge={initials(w.name)}
                    name={w.name}
                    meta={
                      <>
                        {w.addressCount} address{w.addressCount === 1 ? '' : 'es'}
                        {w.excluded && <span className="pill">excluded</span>}
                      </>
                    }
                    usd={w.usd}
                  />
                ))}
          </div>
          {data.flows && <FlowsBlock flows={data.flows} walletScope={!!wallet} scope={scope} />}
        </section>

        <PnlCard pnl={data.pnl} range={range} onRange={setRange} />
        <RiskCard risk={data.risk} hasAave={hasAave} hasDebt={data.aave.borrowedUsd > 0} netUsd={data.totals.netUsd} />
        <YieldCard data={yieldSel.data} loading={yieldSel.loading} range={range} className={currency === 'USD' ? 'card span-12' : 'card span-8'} />
        <CurrencyCard pnl={data.pnl} range={range} />

        <section className="card span-4">
          <div className="card-head">
            <h3>
              <i className="ph ph-link" aria-hidden="true" />
              Allocation by chain
            </h3>
          </div>
          <BarList items={data.byChain} colorOf={chainColor} empty="No balances yet" />
          <div className="card-head sub-head">
            <h3>
              <i className="ph ph-stack" aria-hidden="true" />
              By protocol
            </h3>
          </div>
          <BarList items={data.byProtocol} colorOf={protocolColor} empty="No positions yet" />
        </section>
        <section className="card span-4">
          <div className="card-head">
            <h3>
              <i className="ph ph-ranking" aria-hidden="true" />
              Top holdings
            </h3>
            <span className="hint">owned, gross</span>
          </div>
          <TopHoldings tokens={data.topTokens} totals={data.totals} />
        </section>
        <AaveCard aave={data.aave} curve={data.curve} rates={rates} ratesOpen={ratesOpen} onToggleRates={() => setRatesOpen((v) => !v)} />
        {ratesOpen && <RatesCard rates={rates} range={range} onClose={() => setRatesOpen(false)} />}
        <RecentActivity scope={scope} />
      </div>
    </div>
  );
}
