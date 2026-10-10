'use client';
// Yield & costs (Aave interest earned / paid and gas per day or week), the Aave rate history, the
// currency card (USD against the display currency) and the smart wallet suggestions banner.
import { useState } from 'react';
import type {
  HistoryRange,
  PnlSummary,
  RatesResponse,
  ReserveRateSeries,
  SuggestionActionResponse,
  SuggestionsResponse,
  WalletSuggestion,
  YieldResponse,
} from '../../lib/queries/api-types';
import { LineChart, type LineSeries } from '../charts/LineChart';
import { YieldBars } from '../charts/YieldBars';
import { CHAIN_LABEL, MARKET_LABEL, fmtMoney, fmtPct, fmtShare, fmtUtcDate, shortAddr } from '../format';
import { apiSend, useApi, useApp } from '../layout/Providers';
import { RANGE_TEXT } from './parts';

export function useYield(scope: string, range: HistoryRange) {
  return useApi<YieldResponse>(`/api/yield?scope=${encodeURIComponent(scope)}&range=${range}`);
}

export function useRates(scope: string, range: HistoryRange) {
  return useApi<RatesResponse>(`/api/rates?scope=${encodeURIComponent(scope)}&range=${range}`);
}

const METHOD_TEXT: Record<YieldResponse['method'], string> = {
  ledger: 'Interest measured from your balances and transactions.',
  index: 'Interest measured from the Aave reserve indices.',
  estimate: 'Interest estimated from balances and rates.',
  mixed: 'Interest measured from your transactions where synced, otherwise from the Aave reserve indices.',
  none: '',
};

export function YieldCard({ data, loading, range, className = 'card span-8' }: { data: YieldResponse | null; loading: boolean; range: HistoryRange; className?: string }) {
  const { currency, rate, rateAt, stealth } = useApp();
  // totals in EUR / CHF are summed from the buckets at each day's rate, like the chart and the PnL card
  const conv = (() => {
    if (!data) return null;
    if (currency === 'USD' || !data.buckets.length) {
      const r = currency === 'USD' ? 1 : (rate ?? 1);
      return { earned: data.earnedUsd * r, paid: data.paidUsd * r, gas: data.gasUsd * r, net: data.netUsd * r };
    }
    let earned = 0;
    let paid = 0;
    let gas = 0;
    for (const b of data.buckets) {
      const r = rateAt(b.t) ?? 1;
      earned += b.earnedUsd * r;
      paid += b.paidUsd * r;
      gas += b.gasUsd * r;
    }
    return { earned, paid, gas, net: earned - paid - gas };
  })();
  const native = (v: number, sign = false) => fmtMoney(Math.abs(v) < 0.005 ? 0 : v, currency, 1, { sign, decimals: Math.abs(v) >= 1000 ? 0 : 2 });
  const money = (v: number, sign = false) => fmtMoney(Math.abs(v) < 0.005 ? 0 : v, currency, rate, { sign, decimals: Math.abs(v) >= 1000 ? 0 : 2 });
  const empty = data != null && data.method === 'none' && data.gasUsd < 0.005;
  const assets = (data?.byAsset ?? []).filter((a) => a.earnedUsd >= 0.005 || a.paidUsd >= 0.005);

  return (
    <section className={`${className} yield-card`} aria-labelledby="yield-h">
      <div className="card-head">
        <h3 id="yield-h">
          <i className="ph ph-coins" aria-hidden="true" />
          Yield &amp; costs
        </h3>
        <span className="hint">{RANGE_TEXT[range].long}</span>
      </div>
      {loading && !data ? (
        <div className="skeleton chart-skeleton small" aria-label="Loading yield" />
      ) : !data ? (
        <div className="empty slim">Yield data is not available</div>
      ) : empty ? (
        <div className="empty slim">
          <i className="ph ph-coins" aria-hidden="true" />
          <b>No interest or gas in this range</b>
          Aave interest and the gas your addresses pay show up here.
        </div>
      ) : (
        <>
          <div className="stats yield-stats">
            <div className="stat">
              <span className="stat-label">Interest earned</span>
              <span className="stat-value pos num">{native(conv!.earned, true)}</span>
              <span className="stat-sub">supplied on Aave</span>
            </div>
            <div className="stat">
              <span className="stat-label">Interest paid</span>
              <span className="stat-value neg num">{native(-conv!.paid)}</span>
              <span className="stat-sub">on borrowed assets</span>
            </div>
            <div className="stat">
              <span className="stat-label">Gas</span>
              <span className={`stat-value num ${data.gasUsd >= 0.005 ? 'neg' : 'muted'}`}>{data.gasKnown ? native(-conv!.gas) : '-'}</span>
              <span className="stat-sub">{data.gasKnown ? 'paid by your addresses' : 'pending ledger sync'}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Net</span>
              <span className={`stat-value num ${conv!.net < -0.005 ? 'neg' : conv!.net > 0.005 ? 'pos' : ''}`}>{native(conv!.net, true)}</span>
              <span className="stat-sub">earned - paid - gas</span>
            </div>
          </div>
          {data.buckets.length > 0 && (
            <>
              <div className="legend chart-legend yield-legend">
                <span style={{ ['--sw' as string]: 'var(--c4)' }}>earned</span>
                <span style={{ ['--sw' as string]: 'var(--c5)' }}>paid</span>
                <span className="lg-gas" style={{ ['--sw' as string]: 'var(--c5)' }}>
                  gas
                </span>
                <span className="lg-line" style={{ ['--sw' as string]: 'var(--accent)' }}>
                  net so far
                </span>
                <span className="lg-bucket">per {data.bucket}</span>
              </div>
              <YieldBars buckets={data.buckets} bucket={data.bucket} from={data.from} to={data.to} currency={currency} rateAt={rateAt} stealth={stealth} />
            </>
          )}
          {assets.length > 0 && (
            <ul className="yield-assets" title={currency === 'USD' ? 'By asset' : `By asset, converted at today's USD/${currency} rate`}>
              {assets.map((a) => (
                <li key={a.asset}>
                  <b>{a.symbol}</b>
                  {a.earnedUsd >= 0.005 && <span className="num pos">{money(a.earnedUsd, true)}</span>}
                  {a.paidUsd >= 0.005 && <span className="num neg">{money(-a.paidUsd)}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="footnote">
            {METHOD_TEXT[data.method]}
            {data.estimated ? ' Parts are estimates.' : ''} Valued at the time. Fees charged in tokens (e.g. by DeFi Saver) are not gas and stay in deposits / other.
          </p>
        </>
      )}
    </section>
  );
}

const SUPPLY_COLORS = ['var(--c4)', 'var(--oc)', 'var(--tag)'];
const BORROW_COLORS = ['var(--c5)', 'var(--tag)', 'var(--neutral)'];

export function latestApy(r: ReserveRateSeries, side: 'supply' | 'borrow'): number | null {
  for (let i = r.points.length - 1; i >= 0; i--) {
    const v = side === 'supply' ? r.points[i].supplyApy : r.points[i].borrowApy;
    if (v != null) return v;
  }
  return null;
}

function ratesSeries(rates: RatesResponse): LineSeries[] {
  const out: LineSeries[] = [];
  let si = 0;
  let bi = 0;
  const multiMarket = new Set(rates.reserves.map((r) => r.market)).size > 1;
  for (const r of rates.reserves) {
    const where = multiMarket ? ` (${MARKET_LABEL[r.market] ?? r.market})` : '';
    if (r.supplied)
      out.push({ key: `${r.market}-${r.asset}-s`, label: `${r.symbol} supply${where}`, color: SUPPLY_COLORS[si++ % SUPPLY_COLORS.length], points: r.points.map((p) => ({ t: p.t, v: p.supplyApy })) });
    if (r.borrowed)
      out.push({ key: `${r.market}-${r.asset}-b`, label: `${r.symbol} borrow${where}`, color: BORROW_COLORS[bi++ % BORROW_COLORS.length], points: r.points.map((p) => ({ t: p.t, v: p.borrowApy })) });
  }
  if (rates.netApy.some((p) => p.netApy != null))
    out.push({ key: 'net', label: 'Net APY', color: 'var(--accent)', width: 2.4, points: rates.netApy.map((p) => ({ t: p.t, v: p.netApy })) });
  return out;
}

const pctAxis = (v: number) => `${(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`;

export function RatesCard({ rates, range, onClose, className = 'card span-12' }: { rates: RatesResponse | null; range: HistoryRange; onClose?: () => void; className?: string }) {
  const series = rates ? ratesSeries(rates) : [];
  return (
    <section className={`${className} rates-card`} aria-labelledby="rates-h" id="rates-card">
      <div className="card-head">
        <h3 id="rates-h">
          <i className="ph ph-percent" aria-hidden="true" />
          Aave rates
        </h3>
        <span className="rates-head-right">
          <span className="hint">{RANGE_TEXT[range].long}, daily</span>
          {onClose && (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close rate history" title="Close">
              <i className="ph ph-x" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
      {!rates ? (
        <div className="skeleton chart-skeleton small" aria-label="Loading rates" />
      ) : !series.length ? (
        <div className="empty slim">No rate history for the reserves you hold in this range yet</div>
      ) : (
        <>
          <div className="legend chart-legend">
            {series.map((s) => (
              <span key={s.key} style={{ ['--sw' as string]: s.color }}>
                {s.label}
                <b className="num">{pctAxis(s.points.filter((p) => p.v != null).at(-1)?.v ?? 0)}</b>
              </span>
            ))}
          </div>
          <LineChart series={series} yFmt={(v) => `${(v * 100).toFixed(2)}%`} ariaLabel="Supply, borrow and net APY over time" height={260} />
          <p className="footnote">
            Supply and borrow APY of every reserve you held in the range, and the net APY of your Aave equity: supply interest minus borrow interest, over supplied minus borrowed.
          </p>
        </>
      )}
    </section>
  );
}

/** USD against the display currency over the selected range, and what that did to the value. */
export function CurrencyCard({ pnl, range, className = 'card span-4' }: { pnl?: PnlSummary | null; range: HistoryRange; className?: string }) {
  const { currency, rateSeries, stealth } = useApp();
  if (currency === 'USD') return null;
  const p = pnl?.[range];
  const c = p?.currencies?.[currency];
  const from = p?.fromTs ?? null;
  // a 24h window holds one daily rate at most: show at least the last week for context
  const fromTs = from != null ? Math.min(from, Date.now() / 1000 - 7 * 86400) : null;
  const fromDay = fromTs != null ? new Date(fromTs * 1000).toISOString().slice(0, 10) : null;
  const pts = Object.entries(rateSeries)
    .filter(([d]) => fromDay == null || d >= fromDay)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, v]) => ({ t: Date.parse(`${d}T00:00:00Z`) / 1000, v }));
  const r0 = c?.rateStart ?? pts[0]?.v ?? null;
  const r1 = c?.rateEnd ?? pts.at(-1)?.v ?? null;
  const chg = r0 && r1 ? r1 / r0 - 1 : null;
  const fx = c?.fxEffect ?? null;
  return (
    <section className={`${className} currency-card`} aria-labelledby="cur-h">
      <div className="card-head">
        <h3 id="cur-h">
          <i className="ph ph-currency-circle-dollar" aria-hidden="true" />
          Currency
        </h3>
        <span className="hint">USD/{currency}</span>
      </div>
      <div className="cur-top">
        <div>
          <span className="stat-label">Rate</span>
          <span className="cur-rate num">
            {r1 != null ? r1.toFixed(4) : '-'}
            {chg != null && <small className={chg < 0 ? 'neg' : 'pos'}> {fmtPct(chg, 2)}</small>}
          </span>
        </div>
        <div>
          <span className="stat-label">Currency {fx != null && fx < 0 ? 'loss' : 'gain'}</span>
          <span className={`cur-fx num ${fx == null || Math.abs(fx) < 0.5 ? '' : fx < 0 ? 'neg' : 'pos'}`}>{fx != null ? fmtMoney(fx, currency, 1, { sign: true, decimals: 0 }) : '-'}</span>
        </div>
      </div>
      {pts.length > 1 ? (
        <LineChart
          series={[{ key: 'fx', label: `USD/${currency}`, color: 'var(--tag)', points: pts, width: 1.8 }]}
          yFmt={(v) => v.toFixed(3)}
          height={170}
          zeroLine={false}
          ariaLabel={`USD/${currency} rate over the range`}
        />
      ) : (
        <div className="empty slim">No {currency} rates in this range yet</div>
      )}
      <p className="footnote">
        {chg == null
          ? `All values are stored in USD and converted with the daily USD/${currency} rate.`
          : `USD ${chg >= 0 ? 'gained' : 'lost'} ${fmtShare(Math.abs(chg), 1)} against ${currency} ${RANGE_TEXT[range].long}${from != null ? ` (from ${fmtUtcDate(from)})` : ''}. `}
        {fx != null && chg != null && (stealth ? 'The currency effect is part of the PnL in ' + currency + '.' : `On what you held that is ${fmtMoney(fx, currency, 1, { sign: true, decimals: 0 })}, already part of the PnL in ${currency}.`)}
      </p>
    </section>
  );
}

const SOURCE_TEXT: Record<WalletSuggestion['source'], string> = { dsproxy: 'a DeFi Saver smart wallet', safe: 'a Safe' };

/** Smart wallets (Safe, DSProxy) owned by a tracked address and not tracked yet: add or dismiss. */
export function SuggestionsBanner({ walletId }: { walletId?: number }) {
  const { data, reload } = useApi<SuggestionsResponse>('/api/suggestions');
  const { toast, bump } = useApp();
  const [busy, setBusy] = useState<number | null>(null);
  const list = (data?.suggestions ?? []).filter((s) => walletId == null || s.wallets.some((w) => w.id === walletId));
  if (!list.length) return null;
  const act = async (s: WalletSuggestion, action: 'accept' | 'dismiss') => {
    setBusy(s.id);
    try {
      await apiSend<SuggestionActionResponse>('/api/suggestions', 'POST', { id: s.id, action });
      toast(action === 'accept' ? `Added ${shortAddr(s.address)}, scanning and backfilling now` : 'Suggestion dismissed');
      reload();
      if (action === 'accept') bump();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Request failed', 'err');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {list.map((s) => {
        const owner = s.owner.label ?? s.wallets[0]?.name ?? shortAddr(s.owner.address);
        return (
          <div key={s.id} className="banner suggest-banner" role="status">
            <i className="ph ph-sparkle" aria-hidden="true" />
            <div className="banner-main">
              <b>
                Found {SOURCE_TEXT[s.source] ?? 'a smart wallet'} owned by {owner}. Add it?
              </b>
              <span>
                <span className="num">{shortAddr(s.address)}</span> on {CHAIN_LABEL[s.chain] ?? s.chain}
                {s.wallets.length ? `, added to ${s.wallets.map((w) => w.name).join(' and ')}` : ''}. Its positions and history then count in your net worth.
              </span>
            </div>
            <div className="banner-actions">
              <button className="btn btn-primary" type="button" disabled={busy === s.id} onClick={() => void act(s, 'accept')}>
                <i className="ph ph-plus" aria-hidden="true" />
                Add
              </button>
              <button className="btn" type="button" disabled={busy === s.id} onClick={() => void act(s, 'dismiss')}>
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
