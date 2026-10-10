'use client';
// App-wide client state: currency (USD default, CHF persisted in localStorage), USD->CHF rates,
// toasts and a "data changed" tick that pages use to refetch after a sync.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FxResponse } from '../../lib/queries/api-types';
import { setStealthFlag, type Currency } from '../format';

interface AppState {
  currency: Currency;
  setCurrency: (c: Currency) => void;
  /** latest USD->CHF */
  rate: number | null;
  /** USD->CHF for a unix-seconds timestamp (that day's rate, forward filled), falls back to latest */
  rateAt: (ts: number) => number | null;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
  refreshTick: number;
  bump: () => void;
  /** stealth mode: money and token amounts are masked, percentages stay visible */
  stealth: boolean;
  setStealth: (on: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside Providers');
  return v;
}

const KEY = 'portfolio.currency';
const STEALTH_KEY = 'portfolio.stealth';

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (t as HTMLInputElement).type;
  return !['radio', 'checkbox', 'button', 'submit', 'reset', 'range', 'color'].includes(type);
}

export function Providers({ children }: { children: ReactNode }) {
  const [currency, setCur] = useState<Currency>('USD');
  const [fx, setFx] = useState<FxResponse | null>(null);
  const [toastMsg, setToastMsg] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const [refreshTick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [stealth, setStealthState] = useState(false);
  // set before any child renders so every formatter in this render pass sees the same value
  setStealthFlag(stealth);

  useEffect(() => {
    try {
      const v = localStorage.getItem(KEY);
      if (v === 'CHF' || v === 'USD') setCur(v);
      if (localStorage.getItem(STEALTH_KEY) === '1') setStealthState(true);
    } catch {
      /* storage unavailable */
    }
    fetch('/api/fx')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: FxResponse | null) => j && setFx(j))
      .catch(() => {});
  }, []);

  const setCurrency = useCallback((c: Currency) => {
    setCur(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* ignore */
    }
  }, []);

  const setStealth = useCallback((on: boolean) => {
    setStealthState(on);
    try {
      localStorage.setItem(STEALTH_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute('data-stealth', stealth);
  }, [stealth]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'h' && e.key !== 'H') return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return;
      setStealthState((on) => {
        const next = !on;
        try {
          localStorage.setItem(STEALTH_KEY, next ? '1' : '0');
        } catch {
          /* ignore */
        }
        return next;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const sortedDays = useMemo(() => (fx ? Object.keys(fx.daily).sort() : []), [fx]);
  const rate = fx?.latest?.usdChf ?? null;
  const rateAt = useCallback(
    (ts: number) => {
      if (!fx || !sortedDays.length) return rate;
      const day = new Date(ts * 1000).toISOString().slice(0, 10);
      if (fx.daily[day] != null) return fx.daily[day];
      // binary search the last day <= day
      let lo = 0;
      let hi = sortedDays.length - 1;
      if (day < sortedDays[0]) return fx.daily[sortedDays[0]];
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sortedDays[mid] <= day) lo = mid;
        else hi = mid - 1;
      }
      return fx.daily[sortedDays[lo]] ?? rate;
    },
    [fx, sortedDays, rate],
  );

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToastMsg({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToastMsg(null), 3500);
  }, []);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const value = useMemo<AppState>(
    () => ({ currency, setCurrency, rate, rateAt, toast, refreshTick, bump, stealth, setStealth }),
    [currency, setCurrency, rate, rateAt, toast, refreshTick, bump, stealth, setStealth],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className={`toast${toastMsg?.kind === 'err' ? ' err' : ''}`} role="status" aria-live="polite" hidden={!toastMsg}>
        {toastMsg?.msg}
      </div>
    </Ctx.Provider>
  );
}

/** Fetch JSON from the API; refetches when `deps` / the global refresh tick change, optional polling. */
export function useApi<T>(url: string | null, opts: { pollMs?: number } = {}) {
  const { refreshTick } = useApp();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok) {
          setError((j && typeof j.error === 'string' && j.error) || `Request failed (${r.status})`);
        } else {
          setData(j as T);
          setError(null);
        }
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === 'AbortError')) setError('Could not reach the server');
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    const t = opts.pollMs ? setInterval(load, opts.pollMs) : null;
    return () => {
      alive = false;
      ctrl.abort();
      if (t) clearInterval(t);
    };
  }, [url, refreshTick, n, opts.pollMs]);

  return { data, error, loading: loading && !data, reload };
}

/** JSON request helper for mutations; throws Error(message) on non-2xx. */
export async function apiSend<T = unknown>(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    const details = Array.isArray(j?.details) ? `: ${j.details.map((d: { message?: string }) => d.message).filter(Boolean).join(', ')}` : '';
    throw new Error(`${j?.error ?? `Request failed (${r.status})`}${details}`);
  }
  return j as T;
}
