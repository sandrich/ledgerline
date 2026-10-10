'use client';
// Hand-built SVG area chart: total area or stacked series, hover crosshair with a
// tooltip, days with partial price data marked along the baseline.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryPoint } from '../../lib/queries/api-types';
import { fmtDateTime, fmtMoney, fmtPct, fmtShare, fmtUtcDate, type Currency } from '../format';

export interface SeriesKey {
  key: string;
  label: string;
  color: string;
}

interface Props {
  points: HistoryPoint[];
  keys: SeriesKey[];
  stacked: boolean;
  currency: Currency;
  rateAt: (ts: number) => number | null;
  /** daily points are plotted at their UTC day start; intraday ranges show time in the tooltip */
  intraday: boolean;
  height?: number;
  /** total mode only: draw the unleveraged comparison line (HistoryPoint.unleveredUsd) dashed */
  showUnlevered?: boolean;
  /** stealth mode: no y-axis amounts, tooltip shows % change since the first visible point */
  stealth?: boolean;
}

const PAD = { l: 64, r: 12, t: 12, b: 30 };

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

export function AreaChart({ points, keys, stacked, currency, rateAt, intraday, height = 300, showUnlevered = false, stealth = false }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(260, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const conv = useMemo(
    () =>
      points.map((p) => {
        const r = currency === 'USD' ? 1 : (rateAt(p.t) ?? 1);
        const series: Record<string, number> = {};
        for (const [k, v] of Object.entries(p.series)) series[k] = v * r;
        const debt = (p.debtUsd ?? 0) * r;
        return {
          t: p.t,
          total: p.total * r,
          assets: p.assetsUsd != null ? p.assetsUsd * r : p.total * r + debt,
          unlev: p.unleveredUsd != null ? p.unleveredUsd * r : null,
          debt,
          series,
          partial: !!p.partial,
          rate: r,
        };
      }),
    [points, currency, rateAt],
  );

  const unlevOn = showUnlevered && !stacked && conv.some((p) => p.unlev != null);
  const h = height;
  const padL = stealth ? 14 : PAD.l;
  const iw = w - padL - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const t0 = conv.length ? conv[0].t : 0;
  const t1 = conv.length ? conv[conv.length - 1].t : 1;
  const x = (t: number) => padL + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw);

  // stacked layers (in key order), each an array of [lower, upper]
  const layers = useMemo(() => {
    if (!stacked) return [];
    return keys.map((k, i) =>
      conv.map((p) => {
        let lower = 0;
        for (let j = 0; j < i; j++) lower += p.series[keys[j].key] ?? 0;
        return [lower, lower + (p.series[k.key] ?? 0)] as const;
      }),
    );
  }, [stacked, keys, conv]);

  // Stacked layers need a zero baseline. The total line zooms to the visible range (like DeBank),
  // otherwise a 1% move on a large balance is a flat line.
  const [ymin, ymax] = useMemo(() => {
    if (!conv.length) return [0, 1];
    let lo = stacked ? 0 : Infinity;
    let hi = stacked ? 0 : -Infinity;
    for (const p of conv) {
      hi = Math.max(hi, p.total, unlevOn && p.unlev != null ? p.unlev : -Infinity);
      lo = Math.min(lo, p.total, unlevOn && p.unlev != null ? p.unlev : Infinity);
    }
    for (const l of layers) for (const [a, b] of l) {
      hi = Math.max(hi, a, b);
      lo = Math.min(lo, a, b);
    }
    if (!stacked) {
      // pad by 12% of the range, but at least 0.4% of the value so a nearly flat series is not blown up into noise
      const pad = Math.max((hi - lo) * 0.12, Math.max(Math.abs(hi), Math.abs(lo)) * 0.004, 1);
      const nonNegative = lo >= 0;
      lo -= pad;
      hi += pad;
      if (nonNegative) lo = Math.max(0, lo);
    } else {
      hi *= 1.04;
    }
    if (hi === lo) hi = lo + 1;
    return [lo, hi];
  }, [conv, layers, stacked, unlevOn]);
  const step = niceStep(ymax - ymin, 4);
  const yLo = Math.floor(ymin / step) * step;
  const yHi = Math.ceil(ymax / step) * step || step;
  const y = (v: number) => PAD.t + ih - ((v - yLo) / (yHi - yLo || 1)) * ih;
  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi + 1e-9; v += step) yTicks.push(v);

  // x ticks: about one per 120px
  const xTicks = useMemo(() => {
    const n = Math.max(2, Math.floor(iw / 120));
    const out: number[] = [];
    for (let i = 0; i <= n; i++) out.push(t0 + ((t1 - t0) * i) / n);
    return out;
  }, [iw, t0, t1]);
  const span = t1 - t0;
  const xLabel = (t: number) => {
    const d = new Date(t * 1000);
    if (span <= 2 * 86400) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (span <= 120 * 86400) return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
    return `${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  };

  const linePath = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(conv[i].t).toFixed(1)},${y(v).toFixed(1)}`).join('');
  // gaps (null) start a new segment
  const gapPath = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(conv[i].t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const areaPath = (upper: number[], lower: number[]) => {
    if (!upper.length) return '';
    let d = linePath(upper);
    for (let i = lower.length - 1; i >= 0; i--) d += `L${x(conv[i].t).toFixed(1)},${y(lower[i]).toFixed(1)}`;
    return `${d}Z`;
  };

  // partial price ranges along the baseline
  const partialRuns = useMemo(() => {
    const runs: [number, number][] = [];
    conv.forEach((p, i) => {
      if (!p.partial) return;
      const a = i > 0 ? (conv[i - 1].t + p.t) / 2 : p.t;
      const b = i < conv.length - 1 ? (conv[i + 1].t + p.t) / 2 : p.t;
      const last = runs[runs.length - 1];
      if (last && Math.abs(last[1] - a) < 1) last[1] = b;
      else runs.push([a, b]);
    });
    return runs;
  }, [conv]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!conv.length) return;
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const t = t0 + ((px - padL) / iw) * (t1 - t0);
    let best = 0;
    let lo = 0;
    let hi = conv.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (conv[mid].t < t) lo = mid + 1;
      else hi = mid - 1;
    }
    best = lo >= conv.length ? conv.length - 1 : lo > 0 && t - conv[lo - 1].t < conv[lo].t - t ? lo - 1 : lo;
    setHover(best);
    setTip({ x: e.clientX, y: e.clientY });
  };

  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!conv.length) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const cur = hover ?? conv.length - 1;
      const next = Math.max(0, Math.min(conv.length - 1, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
      setHover(next);
      const svg = e.currentTarget.getBoundingClientRect();
      setTip({ x: svg.left + (x(conv[next].t) / w) * svg.width, y: svg.top + (y(conv[next].total) / h) * svg.height });
    } else if (e.key === 'Escape') setHover(null);
  };

  const hp = hover != null ? conv[hover] : null;
  const money = (v: number) => fmtMoney(v, currency, 1, { decimals: 0 });
  // compact "36.4k" only resolves steps of 100; a zoomed-in axis with finer steps shows full amounts
  const axisMoney = (v: number) => fmtMoney(v, currency, 1, step >= 100 ? { compact: true } : { decimals: step >= 1 ? 0 : 2 });
  const last = conv[conv.length - 1];
  const first = conv[0];
  const sinceStart = (v: number, v0: number | undefined) => (v0 != null && v0 > 0 ? fmtPct(v / v0 - 1) : '-');
  const summary = last
    ? stealth
      ? `Value chart, ${sinceStart(last.total, first?.total)} since ${fmtUtcDate(first.t)}`
      : `Value chart, latest ${money(last.total)} on ${fmtUtcDate(last.t)}`
    : 'Value chart, no data';

  return (
    <div ref={wrap} className="area-chart">
      <svg
        className="chart"
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`${summary}. Use the left and right arrow keys to inspect points.`}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => {
          setHover(null);
          setTip(null);
        }}
      >
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
          </linearGradient>
          <pattern id="partial-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--tag)" strokeWidth="2" opacity="0.5" />
          </pattern>
        </defs>
        <g className="grid">
          {yTicks.map((v) => (
            <line key={v} x1={padL} x2={w - PAD.r} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        {!stealth &&
          yTicks.map((v) => (
            <text key={`yt${v}`} x={padL - 10} y={y(v) + 4} textAnchor="end">
              {axisMoney(v)}
            </text>
          ))}
        {xTicks.map((t, i) => (
          <text key={`xt${i}`} x={x(t)} y={h - 8} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
            {xLabel(t)}
          </text>
        ))}
        {yLo < 0 && <line className="axis" x1={padL} x2={w - PAD.r} y1={y(0)} y2={y(0)} />}
        {partialRuns.map(([a, b], i) => (
          <rect key={`p${i}`} className="partial-band" x={x(a)} y={PAD.t + ih - 6} width={Math.max(2, x(b) - x(a))} height={6} fill="url(#partial-hatch)" />
        ))}
        {conv.length > 0 &&
          (stacked && layers.length ? (
            layers.map((l, i) => (
              <g key={keys[i].key}>
                <path
                  d={areaPath(
                    l.map((v) => v[1]),
                    l.map((v) => v[0]),
                  )}
                  fill={keys[i].color}
                  opacity={0.18}
                />
                <path d={linePath(l.map((v) => v[1]))} fill="none" stroke={keys[i].color} strokeWidth={1.6} />
              </g>
            ))
          ) : (
            <g>
              {unlevOn && (
                <path className="unlev-line" d={gapPath(conv.map((p) => p.unlev))} fill="none" stroke="var(--oc)" strokeWidth={1.5} strokeDasharray="5 4" strokeLinejoin="round" opacity={0.6} />
              )}
              <path d={areaPath(conv.map((p) => p.total), conv.map(() => Math.max(yLo, 0)))} fill="url(#area-fill)" />
              <path d={linePath(conv.map((p) => p.total))} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
            </g>
          ))}
        {hp && (
          <g className="marker">
            <line className="crosshair" x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={PAD.t + ih} />
            {stacked && layers.length ? (
              layers.map((l, i) => <circle key={i} cx={x(hp.t)} cy={y(l[hover!][1])} r={4} fill={keys[i].color} />)
            ) : (
              <>
                {unlevOn && hp.unlev != null && <circle cx={x(hp.t)} cy={y(hp.unlev)} r={3.5} fill="var(--surface)" stroke="var(--oc)" strokeWidth={1.5} />}
                <circle cx={x(hp.t)} cy={y(hp.total)} r={4.5} fill="var(--accent)" />
              </>
            )}
          </g>
        )}
        <rect
          className="hit"
          x={padL}
          y={PAD.t}
          width={Math.max(0, iw)}
          height={Math.max(0, ih)}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => {
            setHover(null);
            setTip(null);
          }}
        />
      </svg>
      {/* Portal to body: cards keep a transform from their entry animation, which traps a nested
          fixed tooltip in the card's stacking context so later cards paint over it. */}
      {hp && tip && typeof document !== 'undefined' && createPortal(
        <div
          className="tooltip"
          role="status"
          style={{
            left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220),
            top: tip.y + 14,
          }}
        >
          <b>{intraday ? fmtDateTime(hp.t) : fmtUtcDate(hp.t)}</b>
          <div className="row">
            <span>
              {!stacked && <i className="sw" style={{ background: 'var(--accent)' }} />}
              {stacked ? 'Total' : 'Net worth'}
            </span>
            <span>{stealth ? sinceStart(hp.total, first?.total) : money(hp.total)}</span>
          </div>
          {!stacked && hp.unlev != null && (unlevOn || hp.debt > 0.5) && (
            <>
              <div className="row">
                <span>
                  <i className="sw sw-dash" aria-hidden="true" />
                  Without leverage
                </span>
                <span>{stealth ? sinceStart(hp.unlev, first?.unlev ?? undefined) : money(hp.unlev)}</span>
              </div>
              <div className="row" title="Net worth minus the unleveraged line: what borrowing added or cost in this range">
                <span>
                  <i className="sw sw-blank" aria-hidden="true" />
                  Leverage effect
                </span>
                <span className={hp.total - hp.unlev < -0.5 ? 'neg' : hp.total - hp.unlev > 0.5 ? 'pos' : undefined}>
                  {stealth ? (hp.unlev > 0 ? fmtPct(hp.total / hp.unlev - 1) : '-') : fmtMoney(hp.total - hp.unlev, currency, 1, { decimals: 0, sign: true })}
                </span>
              </div>
            </>
          )}
          {!stacked && hp.debt > 0.5 && (
            <>
              <div className="row">
                <span>
                  <i className="sw" style={{ background: 'var(--oc)' }} />
                  Assets
                </span>
                <span>{stealth ? sinceStart(hp.assets, first?.assets) : money(hp.assets)}</span>
              </div>
              <div className="row">
                <span>
                  <i className="sw" style={{ background: 'var(--c5)' }} />
                  Debt
                </span>
                <span>{stealth ? `${fmtShare(hp.assets > 0 ? hp.debt / hp.assets : null)} of assets` : money(-hp.debt)}</span>
              </div>
            </>
          )}
          {stacked &&
            keys.map((k) => (
              <div className="row" key={k.key}>
                <span>
                  <i className="sw" style={{ background: k.color }} />
                  {k.label}
                </span>
                <span>{stealth ? fmtShare(hp.total > 0 ? (hp.series[k.key] ?? 0) / hp.total : null) : money(hp.series[k.key] ?? 0)}</span>
              </div>
            ))}
          {stealth && <div className="tip-note muted-note">Change since {intraday ? fmtDateTime(first.t) : fmtUtcDate(first.t)}{stacked ? ', layers as share of total' : ''}</div>}
          {hp.partial && <div className="tip-note">Partial price data: a held token had no price that day and counts as 0</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
