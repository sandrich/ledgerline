'use client';
// DeBank-like address profile: chain summary, wallet token table, Aave V3 sections, history chart.
import Link from 'next/link';
import { useState } from 'react';
import type { AddressDetailResponse, TokenRow } from '../../lib/queries/api-types';
import { HistoryCard, RangePills } from '../charts/HistoryCard';
import { CHAIN_LABEL, MARKET_LABEL, fmtAmount, fmtDate, fmtMoney, fmtPrice, shortAddr } from '../format';
import { useApi, useApp } from '../layout/Providers';
import { RecentActivity } from '../tx/TxList';
import { useScopeRange } from './PortfolioView';
import { BackfillBanner, ChangeText, ErrorCard, Hero, HfMeter, PageSkeleton, backfillText, chainColor } from './parts';

function TokenLogo({ logo, symbol }: { logo: string | null | undefined; symbol: string }) {
  const [broken, setBroken] = useState(false);
  if (!logo || broken) {
    return (
      <span className="tok-fallback" aria-hidden="true">
        {symbol.slice(0, 1)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={logo} alt="" width={22} height={22} loading="lazy" onError={() => setBroken(true)} />;
}

function TokenTable({ rows, caption, borrowed = false }: { rows: TokenRow[]; caption: string; borrowed?: boolean }) {
  const { currency, rate } = useApp();
  return (
    <div className="table-scroll">
      <table className="tokens">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col" className="r">
              Price
            </th>
            <th scope="col" className="r">
              Amount
            </th>
            <th scope="col" className="r">
              {currency} value
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={`${t.chain}-${t.token}`}>
              <td>
                <span className="tok">
                  <TokenLogo logo={t.logo} symbol={t.symbol} />
                  <span>
                    <b>{t.symbol}</b>
                    <small className="muted">{CHAIN_LABEL[t.chain] ?? t.chain}</small>
                  </span>
                </span>
              </td>
              <td className="r num dim">{fmtPrice(t.price, currency, rate)}</td>
              <td className="r num">{fmtAmount(t.amount)}</td>
              <td className={`r num${borrowed ? ' neg' : ''}`}>{fmtMoney(borrowed ? Math.abs(t.usd) : t.usd, currency, rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AddressView({ address }: { address: string }) {
  const { data, error, loading, reload } = useApi<AddressDetailResponse>(`/api/address/${address}`, { pollMs: 60_000 });
  const { currency, rate } = useApp();
  const [range, setRange] = useScopeRange(`address:${address}`, 'all');
  const [showHidden, setShowHidden] = useState(false);

  if (loading) return <PageSkeleton />;
  if (error && !data) return <ErrorCard message={error} onRetry={reload} />;
  if (!data) return null;
  const a = data.address;
  const visibleTokens = data.wallet.tokens.filter((t) => !t.spam);

  return (
    <div className="view">
      <nav className="crumbs" aria-label="Breadcrumb">
        {a.wallets[0] ? (
          <Link href={`/wallets/${a.wallets[0].id}`}>
            <i className="ph ph-wallet" aria-hidden="true" />
            {a.wallets[0].name}
          </Link>
        ) : (
          <Link href="/">Overview</Link>
        )}
        <i className="ph ph-caret-right" aria-hidden="true" />
        <span className="num">{shortAddr(a.address)}</span>
      </nav>
      <Hero
        eyebrow={a.label ? `Address, ${a.label}` : 'Address'}
        title={fmtMoney(data.totals.netUsd, currency, rate, { decimals: 0 })}
        em="net"
        sub={
          <>
            <span className="num addr-full">{a.address}</span>
            <br />
            24h <ChangeText c={data.change['24h']} />, {backfillText(data.backfill)}
            {a.isContract && Object.values(a.isContract).some(Boolean) ? ', smart contract account' : ''}.
          </>
        }
        right={<RangePills value={range} onChange={setRange} />}
      />
      <BackfillBanner addressIds={[a.id]} />

      <div className="chain-row" role="list">
        {data.chains.map((c) => (
          <div key={c.key} className="chain-chip" role="listitem">
            <i className="sw" style={{ background: chainColor(c.key) }} />
            <span>{c.label}</span>
            <b className="num">{fmtMoney(c.usd, currency, rate)}</b>
            <span className="muted num">{c.share >= 0 ? `${(c.share * 100).toFixed(0)}%` : '-'}</span>
          </div>
        ))}
        <div className="chain-chip" role="listitem">
          <i className="sw" style={{ background: 'var(--neutral)' }} />
          <span>Last snapshot</span>
          <b className="num">{data.lastSnapshotAt ? fmtDate(data.lastSnapshotAt) : '-'}</b>
        </div>
      </div>

      <div className="bento">
        <HistoryCard scope={`address:${a.address}`} range={range} groups={['none', 'chain', 'protocol']} className="card span-12" title="Value history" />
        <RecentActivity scope={`address:${a.address}`} />

        <section className="card span-12">
          <div className="card-head">
            <h3>
              <i className="ph ph-wallet" aria-hidden="true" />
              Wallet
            </h3>
            <span className="num total">{fmtMoney(data.wallet.usd, currency, rate)}</span>
          </div>
          {visibleTokens.length ? (
            <TokenTable rows={visibleTokens} caption="Wallet tokens" />
          ) : (
            <div className="empty slim">No priced tokens held directly</div>
          )}
          {data.hidden.count > 0 && (
            <div className="hidden-tokens">
              <button className="btn btn-ghost" type="button" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
                <i className={`ph ${showHidden ? 'ph-caret-up' : 'ph-caret-down'}`} aria-hidden="true" />
                {data.hidden.count} hidden token{data.hidden.count === 1 ? '' : 's'}
              </button>
              {showHidden && <TokenTable rows={data.hidden.tokens} caption="Hidden tokens (spam or no price)" />}
            </div>
          )}
        </section>

        {data.protocols.map((p) => (
          <section key={`${p.market}-${p.chain}`} className="card span-12 protocol">
            <div className="card-head">
              <h3>
                <i className="ph ph-bank" aria-hidden="true" />
                {MARKET_LABEL[p.market] ?? p.market}
                <span className="pill">{CHAIN_LABEL[p.chain] ?? p.chain}</span>
              </h3>
              <span className="proto-head">
                <span className="muted small">Health factor</span>
                <HfMeter hf={p.healthFactor} hasDebt={p.borrowedUsd > 0} />
                <span className="num total">{fmtMoney(p.netUsd, currency, rate)}</span>
              </span>
            </div>
            <div className="proto-grid">
              <div>
                <h4>
                  Supplied <span className="num muted">{fmtMoney(p.suppliedUsd, currency, rate)}</span>
                </h4>
                {p.supplied.length ? <TokenTable rows={p.supplied} caption="Supplied" /> : <div className="empty slim">Nothing supplied</div>}
              </div>
              <div>
                <h4>
                  Borrowed <span className="num muted">{fmtMoney(p.borrowedUsd, currency, rate)}</span>
                </h4>
                {p.borrowed.length ? <TokenTable rows={p.borrowed} caption="Borrowed" borrowed /> : <div className="empty slim">No debt</div>}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
