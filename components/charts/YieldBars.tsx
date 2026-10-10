'use client';
// Interest and gas per day or week: interest earned grows up (green), interest paid and gas grow down
// (red, gas lighter), the running net total is a line on its own scale (right axis). Amounts go
// through fmtMoney, so stealth mode masks the axes and the tooltip; bar shapes alone reveal nothing.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { YieldBucket } from '../../lib/queries/api-types';
import { fmtMoney, fmtUtcDate, type Currency } from '../format';

const PAD = { l: 66, r: 74, t: 10, b: 26 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

export function YieldBars({
  buckets,
  bucket,
  currency,
  rateAt,
  stealth,
  from,
  to,
  height = 220,
}: {
  buckets: YieldBucket[];
  /** range bounds (unix s): bars sit at their time, so days without interest or gas stay empty */
  from: number;
  to: number;
  bucket: 'day' | 'week';
  currency: Currency;
  rateAt: (ts: number) => number | null;
  stealth: boolean;
  height?: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(700);
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(240, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // convert each bucket at its own day's rate; the cumulative line re-sums the converted values
  let run = 0;
  const rows = buckets.map((b) => {
    const r = currency === 'USD' ? 1 : (rateAt(b.t) ?? 1);
    const earned = b.earnedUsd * r;
    const paid = b.paidUsd * r;
    const gas = b.gasUsd * r;
    run += earned - paid - gas;
    return { t: b.t, earned, paid, gas, net: earned - paid - gas, cum: run };
  });
  const padL = stealth ? 12 : PAD.l;
  const padR = stealth ? 12 : PAD.r;
  const h = height;
  const iw = w - padL - padR;
  const ih = h - PAD.t - PAD.b;
  const up = niceMax(Math.max(...rows.map((r) => r.earned), 0));
  const down = niceMax(Math.max(...rows.map((r) => r.paid + r.gas), 0));
  const top = Math.max(...rows.map((r) => r.earned), 0) > 0 ? up : 0;
  const bot = Math.max(...rows.map((r) => r.paid + r.gas), 0) > 0 ? down : 0;
  const span = top + bot || 1;
  const yBar = (v: number) => PAD.t + ((top - v) / span) * ih;
  const zeroY = yBar(0);
  const cMin = Math.min(0, ...rows.map((r) => r.cum));
  const cMax = Math.max(0, ...rows.map((r) => r.cum));
  const cSpan = cMax - cMin || 1;
  const yCum = (v: number) => PAD.t + ((cMax - v) / cSpan) * ih;
  const bsec = bucket === 'week' ? 7 * 86400 : 86400;
  const t0 = Math.min(Math.floor(from / bsec) * bsec, rows[0]?.t ?? from);
  const t1 = Math.max(to, (rows.at(-1)?.t ?? to) + bsec);
  const n = Math.max(1, Math.ceil((t1 - t0) / bsec));
  const slot = iw / n;
  const bw = Math.max(1.5, Math.min(26, slot * 0.66));
  const cx = (i: number) => padL + ((rows[i].t - t0) / bsec + 0.5) * slot;
  const money = (v: number, sign = false) => fmtMoney(v, currency, 1, { sign, decimals: Math.abs(v) >= 100 ? 0 : 2 });
  // labels carry the year when there are many buckets: give them more room so they never overlap
  const nTicks = Math.max(2, Math.floor(iw / (n > 60 ? 130 : 90)));
  const ticks = Array.from({ length: nTicks + 1 }, (_, i) => t0 + ((t1 - t0 - bsec) * i) / nTicks);
  const p2 = (v: number) => String(v).padStart(2, '0');
  const xLabel = (t: number) => {
    const d = new Date(t * 1000);
    return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}${n > 60 ? `.${String(d.getUTCFullYear()).slice(2)}` : ''}`;
  };
  // step line: the running total only moves at buckets with interest or gas
  const cumPath = rows.map((r, i) => `${i ? `L${cx(i).toFixed(1)},${yCum(rows[i - 1].cum).toFixed(1)}L` : 'M'}${cx(i).toFixed(1)},${yCum(r.cum).toFixed(1)}`).join('');

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * w;
    if (!rows.length) return;
    const t = t0 + ((px - padL) / slot - 0.5) * bsec;
    let best = 0;
    for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].t - t) < Math.abs(rows[best].t - t)) best = i;
    setHover(best);
    setTip({ x: e.clientX, y: e.clientY });
  };
  const hr = hover != null ? rows[hover] : null;
  const last = rows[rows.length - 1];

  return (
    <div ref={wrap} className="area-chart yield-bars">
      <svg
        className="chart"
        viewBox={`0 0 ${w} ${h}`}
        width={w}
        height={h}
        role="img"
        aria-label={`Interest and gas per ${bucket}${last && !stealth ? `, net ${money(last.cum, true)} over the range` : ''}`}
      >
        <g className="grid">
          {top > 0 && <line x1={padL} x2={w - padR} y1={yBar(top)} y2={yBar(top)} />}
          {bot > 0 && <line x1={padL} x2={w - padR} y1={yBar(-bot)} y2={yBar(-bot)} />}
        </g>
        {!stealth && (
          <>
            {top > 0 && (
              <text x={padL - 8} y={yBar(top) + 4} textAnchor="end">
                {money(top, true)}
              </text>
            )}
            <text x={padL - 8} y={zeroY + 4} textAnchor="end">
              {money(0)}
            </text>
            {bot > 0 && (
              <text x={padL - 8} y={yBar(-bot) + 4} textAnchor="end">
                {money(-bot, true)}
              </text>
            )}
            <text x={w - padR + 8} y={yCum(cMax) + 4} textAnchor="start" className="cum-tick">
              {money(cMax, true)}
            </text>
            {cMin < 0 && (
              <text x={w - padR + 8} y={yCum(cMin) + 4} textAnchor="start" className="cum-tick">
                {money(cMin, true)}
              </text>
            )}
          </>
        )}
        {ticks.map((t, i) => (
          <text key={`x${i}`} x={padL + ((t - t0) / bsec + 0.5) * slot} y={h - 6} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
            {xLabel(t)}
          </text>
        ))}
        {rows.map((r, i) => (
          <g key={r.t} className={hover === i ? 'yb on' : 'yb'}>
            {r.earned > 0 && <rect x={cx(i) - bw / 2} y={yBar(r.earned)} width={bw} height={Math.max(0.5, zeroY - yBar(r.earned))} rx={Math.min(3, bw / 3)} fill="var(--c4)" />}
            {r.paid > 0 && <rect x={cx(i) - bw / 2} y={zeroY} width={bw} height={Math.max(0.5, yBar(-r.paid) - zeroY)} fill="var(--c5)" />}
            {r.gas > 0 && <rect x={cx(i) - bw / 2} y={yBar(-r.paid)} width={bw} height={Math.max(0.5, yBar(-r.paid - r.gas) - yBar(-r.paid))} fill="var(--c5)" opacity={0.45} />}
          </g>
        ))}
        <line className="axis" x1={padL} x2={w - padR} y1={zeroY} y2={zeroY} />
        {rows.length > 1 && <path d={cumPath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />}
        {hr && hover != null && <circle cx={cx(hover)} cy={yCum(hr.cum)} r={4} fill="var(--accent)" />}
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
      {hr &&
        tip &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="tooltip" role="status" style={{ left: Math.min(tip.x + 14, window.innerWidth - 240), top: tip.y + 14 }}>
            <b>
              {bucket === 'week' ? 'Week of ' : ''}
              {fmtUtcDate(hr.t)}
            </b>
            <div className="row">
              <span>
                <i className="sw" style={{ background: 'var(--c4)' }} />
                Interest earned
              </span>
              <span>{money(hr.earned, true)}</span>
            </div>
            <div className="row">
              <span>
                <i className="sw" style={{ background: 'var(--c5)' }} />
                Interest paid
              </span>
              <span>{money(-hr.paid)}</span>
            </div>
            <div className="row">
              <span>
                <i className="sw" style={{ background: 'var(--c5)', opacity: 0.45 }} />
                Gas
              </span>
              <span>{money(-hr.gas)}</span>
            </div>
            <div className="row">
              <span>
                <i className="sw" style={{ background: 'var(--accent)' }} />
                Net so far
              </span>
              <span>{money(hr.cum, true)}</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
