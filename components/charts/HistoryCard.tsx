'use client';
import { useEffect, useState } from 'react';
import type { GroupBy, HistoryRange, HistoryResponse } from '../../lib/queries/api-types';
import { CHAIN_COLOR, SERIES_COLORS, fmtMoney, fmtPct, fmtShare, fmtUtcDate } from '../format';
import { useApi, useApp } from '../layout/Providers';
import { AreaChart, type SeriesKey } from './AreaChart';

export const RANGES: { key: HistoryRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y', label: '1y' },
  { key: 'all', label: 'All' },
];

export function RangePills({ value, onChange }: { value: HistoryRange; onChange: (r: HistoryRange) => void }) {
  return (
    <div className="seg range-seg" role="radiogroup" aria-label="Chart range">
      {RANGES.map((r) => (
        <label key={r.key}>
          <input type="radio" name="range" value={r.key} checked={value === r.key} onChange={() => onChange(r.key)} />
          {r.label}
        </label>
      ))}
    </div>
  );
}

const UNLEV_KEY = 'portfolio.showUnlevered';

const GROUP_LABEL: Record<GroupBy, string> = { none: 'Total', chain: 'Chain', wallet: 'Wallet', protocol: 'Protocol' };

export function HistoryCard({
  scope,
  range,
  groups,
  className = 'card span-8',
  title = 'Net worth',
  defaultGroup = 'none',
}: {
  scope: string;
  range: HistoryRange;
  groups: GroupBy[];
  className?: string;
  title?: string;
  /** used until the user picks a grouping for this scope (the choice is remembered per scope) */
  defaultGroup?: GroupBy;
}) {
  const { currency, rateAt, stealth } = useApp();
  const [showUnlev, setShowUnlevState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(UNLEV_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const toggleUnlev = () => {
    setShowUnlevState((v) => {
      try {
        localStorage.setItem(UNLEV_KEY, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };
  const storeKey = `portfolio.groupBy.${scope}`;
  // Only mounted on the client after data loaded, so reading storage in the initializer is safe.
  const [groupBy, setGroupByState] = useState<GroupBy>(() => {
    try {
      const v = localStorage.getItem(storeKey) as GroupBy | null;
      if (v && groups.includes(v)) return v;
    } catch {
      /* storage unavailable */
    }
    return groups.includes(defaultGroup) ? defaultGroup : 'none';
  });
  const setGroupBy = (g: GroupBy) => {
    setGroupByState(g);
    try {
      localStorage.setItem(storeKey, g);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    if (!groups.includes(groupBy)) setGroupByState(groups.includes(defaultGroup) ? defaultGroup : 'none');
  }, [groups, groupBy, defaultGroup]);
  const { data, error, loading, reload } = useApi<HistoryResponse>(
    `/api/history?scope=${encodeURIComponent(scope)}&range=${range}&groupBy=${groupBy}`,
  );

  const keys: SeriesKey[] =
    data?.keys.map((k, i) => ({
      key: k.key,
      label: k.label,
      color: k.color ?? (groupBy === 'chain' ? (CHAIN_COLOR[k.key] ?? SERIES_COLORS[i % SERIES_COLORS.length]) : SERIES_COLORS[i % SERIES_COLORS.length]),
    })) ?? [];
  const pts = data?.points ?? [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const fx = (t: number) => (currency === 'USD' ? 1 : (rateAt(t) ?? 1));
  const delta = first && last ? last.total * fx(last.t) - first.total * fx(first.t) : null;
  const deltaPct = first && last && first.total > 0 ? last.total / first.total - 1 : null;
  const partialDays = pts.filter((p) => p.partial).length;
  // without debt the unleveraged line equals net worth: nothing to compare
  const hasDebt = pts.some((p) => (p.debtUsd ?? 0) > 1) && pts.some((p) => p.unleveredUsd != null);
  const levEffect = last?.unleveredUsd != null ? (last.total - last.unleveredUsd) * fx(last.t) : null;
  const totalMode = groupBy === 'none';
  const r = 1; // values above are already converted

  return (
    <section className={className} aria-labelledby={`hist-${scope}`}>
      <div className="card-head">
        <h3 id={`hist-${scope}`}>
          <i className="ph ph-chart-line-up" aria-hidden="true" />
          {title}
        </h3>
        {groups.length > 1 && (
          <div className="seg small-seg" role="radiogroup" aria-label="Stack by">
            {groups.map((g) => (
              <label key={g}>
                <input type="radio" name={`group-${scope}`} value={g} checked={groupBy === g} onChange={() => setGroupBy(g)} />
                {GROUP_LABEL[g]}
              </label>
            ))}
          </div>
        )}
      </div>
      {!totalMode && keys.length > 0 && (
        <div className="legend chart-legend">
          {keys.map((k) => (
            <span key={k.key} style={{ ['--sw' as string]: k.color }}>
              {k.label}
              {last && last.series[k.key] != null && (
                <b className="num">
                  {stealth
                    ? fmtShare(last.total > 0 ? last.series[k.key] / last.total : null, 0)
                    : fmtMoney(last.series[k.key] * fx(last.t), currency, 1, { compact: true })}
                </b>
              )}
            </span>
          ))}
        </div>
      )}
      {totalMode && hasDebt && !loading && pts.length >= 2 && (
        <div className="legend chart-legend line-legend">
          <span className="ll-net">
            <i className="ll-sw" aria-hidden="true" />
            Net worth
          </span>
          <button
            type="button"
            className={`ll-toggle${showUnlev ? ' on' : ''}`}
            aria-pressed={showUnlev}
            onClick={toggleUnlev}
            title="The same deposits and withdrawals, but holding the gross assets without debt: below net worth when leverage paid off, above when it cost"
          >
            <i className="ll-sw dash" aria-hidden="true" />
            Without leverage
            {!stealth && last?.unleveredUsd != null && <b className="num">{fmtMoney(last.unleveredUsd * fx(last.t), currency, 1, { compact: true })}</b>}
          </button>
          {levEffect != null && (
            <span className="ll-effect" title="Net worth minus the unleveraged line at the end of the range">
              leverage effect{' '}
              <b className={`num ${levEffect < -0.5 ? 'neg' : levEffect > 0.5 ? 'pos' : ''}`}>
                {stealth
                  ? last!.unleveredUsd! > 0
                    ? fmtPct(last!.total / last!.unleveredUsd! - 1)
                    : '-'
                  : fmtMoney(levEffect, currency, 1, { compact: true, sign: true })}
              </b>
            </span>
          )}
        </div>
      )}
      {loading ? (
        <div className="skeleton chart-skeleton" aria-label="Loading chart" />
      ) : error ? (
        <div className="card-error">
          <i className="ph ph-warning-circle" aria-hidden="true" />
          <div>
            <b>Chart unavailable</b>
            <span>{error}</span>
          </div>
          <button className="btn" type="button" onClick={reload}>
            Retry
          </button>
        </div>
      ) : pts.length < 2 ? (
        <div className="empty slim">
          <i className="ph ph-chart-line" aria-hidden="true" />
          <b>No history in this range yet</b>
          The backfill fills the chart from the right, newest days first.
        </div>
      ) : (
        <AreaChart
          points={pts}
          keys={keys}
          stacked={!totalMode}
          currency={currency}
          rateAt={rateAt}
          intraday={range === '24h' || range === '7d'}
          showUnlevered={showUnlev && hasDebt}
          stealth={stealth}
        />
      )}
      {pts.length >= 2 && (
        <div className="card-foot">
          <span>
            From <b>{fmtUtcDate(first.t)}</b> to <b>{fmtUtcDate(last.t)}</b>
          </span>
          <span>
            Change <b className={delta != null && delta < 0 ? 'neg' : 'pos'}>{fmtMoney(delta, currency, r, { sign: true, decimals: 0 })}</b>{' '}
            <span className={deltaPct != null && deltaPct < 0 ? 'neg' : 'pos'}>{fmtPct(deltaPct)}</span>
          </span>
          {partialDays > 0 && (
            <span className="partial-note" title="A held token had no historical price on these days, it is counted as 0">
              <i className="hatch-sw" aria-hidden="true" />
              {partialDays} point{partialDays === 1 ? '' : 's'} with partial price data
            </span>
          )}
        </div>
      )}
    </section>
  );
}
