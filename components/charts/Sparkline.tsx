'use client';
// Tiny trend line for list rows (wallet / address cards). Fetches the scope's history for the
// selected range; the caller shows the change next to it.
import type { HistoryRange, HistoryResponse } from '../../lib/queries/api-types';
import { useApi } from '../layout/Providers';

export function useScopeHistory(scope: string, range: HistoryRange) {
  const { data } = useApi<HistoryResponse>(`/api/history?scope=${encodeURIComponent(scope)}&range=${range}&groupBy=none`);
  const pts = data?.points ?? [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  const pct = first && last && first.total > 0 && pts.length > 1 ? last.total / first.total - 1 : null;
  return { points: pts, pct };
}

export function Sparkline({ values, color = 'var(--accent)', width = 72, height = 26 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <svg className="spark" width={width} height={height} aria-hidden="true" />;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = hi - lo || Math.abs(hi) || 1;
  const pad = 2;
  const step = (width - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => `${(pad + i * step).toFixed(1)},${(pad + (1 - (v - lo) / span) * (height - pad * 2)).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${(pad + (values.length - 1) * step).toFixed(1)},${height}L${pad},${height}Z`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
