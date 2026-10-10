// Display currency rates (fx table: units of the currency per USD per day, from Frankfurter, forward
// filled to every calendar day up to the last published day). A time without a rate uses the last
// earlier day (weekends, today before publication); a time before the first day uses the first day.
// Reads the legacy single currency table (fx(day, usd_chf), before migration 7) as CHF.
import { FX_CURRENCIES, type FxCurrency, type FxResponse } from './api-types';
import { all, type QDb } from './db';

export interface FxBook {
  currencies: FxCurrency[];
  /** units of `currency` per USD at unix time t; null when that currency has no rate at all */
  rateAt: (currency: FxCurrency, t: number) => number | null;
  latest: (currency: FxCurrency) => { day: string; rate: number } | null;
  daily: (currency: FxCurrency) => Record<string, number>;
}

function legacyTable(db: QDb): boolean {
  return all<{ name: string }>(db, 'PRAGMA table_info(fx)').some((c) => c.name === 'usd_chf');
}

function loadRows(db: QDb): { day: string; currency: string; rate: number }[] {
  const cols = all<{ name: string }>(db, 'PRAGMA table_info(fx)');
  if (!cols.length) return [];
  if (legacyTable(db)) {
    return all<{ day: string; rate: number }>(db, 'SELECT day, usd_chf AS rate FROM fx ORDER BY day').map((r) => ({ ...r, currency: 'CHF' }));
  }
  return all<{ day: string; currency: string; rate: number }>(db, 'SELECT day, currency, rate_from_usd AS rate FROM fx ORDER BY day');
}

export function isoDayOf(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function loadFx(db: QDb): FxBook {
  const series = new Map<FxCurrency, { days: string[]; rates: number[] }>();
  for (const c of FX_CURRENCIES) series.set(c, { days: [], rates: [] });
  for (const r of loadRows(db)) {
    const s = series.get(r.currency as FxCurrency);
    if (!s || !(r.rate > 0)) continue;
    s.days.push(r.day);
    s.rates.push(r.rate);
  }
  const memo = new Map<string, number | null>();
  const rateAt = (c: FxCurrency, t: number): number | null => {
    const s = series.get(c);
    if (!s || !s.days.length) return null;
    const day = isoDayOf(t);
    const mk = `${c}|${day}`;
    const hit = memo.get(mk);
    if (hit !== undefined) return hit;
    let lo = 0;
    let hi = s.days.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s.days[mid] <= day) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const v = s.rates[best];
    memo.set(mk, v);
    return v;
  };
  return {
    currencies: FX_CURRENCIES.filter((c) => (series.get(c)?.days.length ?? 0) > 0),
    rateAt,
    latest: (c) => {
      const s = series.get(c);
      if (!s?.days.length) return null;
      return { day: s.days[s.days.length - 1], rate: s.rates[s.rates.length - 1] };
    },
    daily: (c) => {
      const s = series.get(c);
      const out: Record<string, number> = {};
      if (s) s.days.forEach((d, i) => (out[d] = s.rates[i]));
      return out;
    },
  };
}

export function getFx(db: QDb): FxResponse {
  const fx = loadFx(db);
  const chf = fx.latest('CHF');
  const eur = fx.latest('EUR');
  const days = [chf?.day, eur?.day].filter((d): d is string => !!d).sort();
  const rates = {} as Record<FxCurrency, Record<string, number>>;
  for (const c of FX_CURRENCIES) rates[c] = fx.daily(c);
  return {
    // the legacy usdChf field is required, so latest stays null until CHF has a rate (both are synced together)
    latest: chf ? { day: days[days.length - 1], usdChf: chf.rate, EUR: eur?.rate ?? null, CHF: chf.rate } : null,
    daily: rates.CHF,
    rates,
  };
}
