'use client';
// Hand-built multi-line SVG chart (no library), used for rate histories (APY in percent) and the
// USD/EUR or USD/CHF rate. Each series has its own points; hover shows every series at the nearest
// timestamp. Values here are percentages or exchange rates, never amounts, so nothing is masked.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fmtDateTime, fmtUtcDate } from '../format';

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
  width?: number;
  dash?: string;
}

const PAD = { l: 52, r: 12, t: 10, b: 26 };

function niceStep(range: number, ticks: number): number {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1e-9));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

/** index of the point nearest to t (points sorted by t) */
function nearest(points: { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid - 1;
  }
  if (lo >= points.length) return points.length - 1;
  if (lo > 0 && t - points[lo - 1].t < points[lo].t - t) return lo - 1;
  return lo;
}

export function LineChart({
  series,
  height = 240,
  yFmt,
  intraday = false,
  zeroLine = true,
  ariaLabel,
}: {
  series: LineSeries[];
  height?: number;
  /** axis and tooltip label of a value */
  yFmt: (v: number) => string;
  intraday?: boolean;
  /** draw the 0 line when the range crosses it */
  zeroLine?: boolean;
  ariaLabel: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(700);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(240, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = series.filter((s) => s.points.some((p) => p.v != null));
  const allT = useMemo(() => [...new Set(shown.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b), [shown]);
  const t0 = allT[0] ?? 0;
  const t1 = allT[allT.length - 1] ?? 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of shown)
    for (const p of s.points)
      if (p.v != null) {
        lo = Math.min(lo, p.v);
        hi = Math.max(hi, p.v);
      }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  const pad = Math.max((hi - lo) * 0.1, Math.abs(hi) * 0.02, 1e-6);
  lo -= pad;
  hi += pad;
  const step = niceStep(hi - lo, 4);
  const yLo = Math.floor(lo / step) * step;
  const yHi = Math.ceil(hi / step) * step;
  const h = height;
  const iw = w - PAD.l - PAD.r;
  const ih = h - PAD.t - PAD.b;
  const x = (t: number) => PAD.l + (t1 === t0 ? iw : ((t - t0) / (t1 - t0)) * iw);
  const y = (v: number) => PAD.t + ih - ((v - yLo) / (yHi - yLo || 1)) * ih;
  const yTicks: number[] = [];
  for (let v = yLo; v <= yHi + step * 1e-6; v += step) yTicks.push(v);
  const nX = Math.max(2, Math.floor(iw / 120));
  const xTicks = Array.from({ length: nX + 1 }, (_, i) => t0 + ((t1 - t0) * i) / nX);
  const span = t1 - t0;
  const xLabel = (t: number) => {
    const d = new Date(t * 1000);
    const p2 = (n: number) => String(n).padStart(2, '0');
    if (span <= 2 * 86400) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
    if (span <= 120 * 86400) return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}`;
    return `${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
  };
  // a series is not interpolated across long gaps (e.g. days a reserve was not held)
  const gaps = allT.slice(1).map((t, i) => t - allT[i]).sort((a, b) => a - b);
  const maxGap = Math.max(3 * (gaps[Math.floor(gaps.length / 2)] ?? 86400), 1.5 * 86400);
  const path = (pts: { t: number; v: number | null }[]) => {
    let d = '';
    let pen = false;
    let prevT = -Infinity;
    for (const p of pts) {
      if (p.v == null || p.t - prevT > maxGap) pen = false;
      if (p.v != null) prevT = p.t;
      if (p.v == null) continue;
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!allT.length) return;
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    const t = t0 + ((px - PAD.l) / iw) * (t1 - t0);
    setHoverT(allT[nearest(allT.map((v) => ({ t: v })), t)]);
    setTip({ x: e.clientX, y: e.clientY });
  };
  const at = (s: LineSeries, t: number) => {
    if (!s.points.length) return null;
    const p = s.points[nearest(s.points, t)];
    return p && Math.abs(p.t - t) <= Math.max(86400 * 1.5, span / 200) ? p.v : null;
  };

  return (
    <div ref={wrap} className="area-chart line-chart">
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={ariaLabel}>
        <g className="grid">
          {yTicks.map((v) => (
            <line key={v} x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} />
          ))}
        </g>
        {yTicks.map((v) => (
          <text key={`y${v}`} x={PAD.l - 8} y={y(v) + 4} textAnchor="end">
            {yFmt(v)}
          </text>
        ))}
        {xTicks.map((t, i) => (
          <text key={`x${i}`} x={x(t)} y={h - 6} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>
            {xLabel(t)}
          </text>
        ))}
        {zeroLine && yLo < 0 && yHi > 0 && <line className="axis" x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} />}
        {shown.map((s) => (
          <path key={s.key} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.6} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {hoverT != null && (
          <g className="marker">
            <line className="crosshair" x1={x(hoverT)} x2={x(hoverT)} y1={PAD.t} y2={PAD.t + ih} />
            {shown.map((s) => {
              const v = at(s, hoverT);
              return v == null ? null : <circle key={s.key} cx={x(hoverT)} cy={y(v)} r={3.5} fill={s.color} />;
            })}
          </g>
        )}
        <rect
          className="hit"
          x={PAD.l}
          y={PAD.t}
          width={Math.max(0, iw)}
          height={Math.max(0, ih)}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => {
            setHoverT(null);
            setTip(null);
          }}
        />
      </svg>
      {hoverT != null &&
        tip &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="tooltip" role="status" style={{ left: Math.min(tip.x + 14, window.innerWidth - 240), top: tip.y + 14 }}>
            <b>{intraday ? fmtDateTime(hoverT) : fmtUtcDate(hoverT)}</b>
            {shown.map((s) => {
              const v = at(s, hoverT);
              return (
                <div className="row" key={s.key}>
                  <span>
                    <i className="sw" style={{ background: s.color }} />
                    {s.label}
                  </span>
                  <span>{v == null ? '-' : yFmt(v)}</span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
