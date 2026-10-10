// Display formatting: Swiss apostrophe thousands, $ / CHF, dd.mm.yyyy dates,
// subscript zeros for tiny amounts, short addresses. Empty values render as '-'.

export type Currency = 'USD' | 'CHF';

// ---------- stealth mode ----------
// When on, every money amount and token amount renders as MASK. Percentages, prices, rates and
// ratios stay visible. The flag is module state set by <Providers> during render (before any child
// renders), so every formatter below honours it without each caller having to pass it along.
export const MASK = '•••••';
let stealthOn = false;
export function setStealthFlag(on: boolean): void {
  stealthOn = on;
}
export function isStealth(): boolean {
  return stealthOn;
}

const SUB = ['₀', '₁', '₂', '₃', '₄', '₅', '₆', '₇', '₈', '₉'];

/** Group the integer part with apostrophes: 1234567.5 -> 1'234'567.5 */
export function groupSwiss(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac] = body.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${neg ? '-' : ''}${g}${frac != null ? `.${frac}` : ''}`;
}

export function fmtNumber(n: number | null | undefined, decimals = 0): string {
  if (n == null || !Number.isFinite(n)) return '-';
  return groupSwiss(n.toFixed(decimals));
}

/** Money in the selected currency. `usd` is converted with `rate` (USD->CHF) when CHF. */
export function fmtMoney(
  usd: number | null | undefined,
  cur: Currency,
  rate: number | null,
  opts: { decimals?: number; sign?: boolean; compact?: boolean } = {},
): string {
  if (usd == null || !Number.isFinite(usd)) return '-';
  if (stealthOn) return MASK;
  const v = cur === 'CHF' && rate ? usd * rate : usd;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : opts.sign && v > 0 ? '+' : '';
  if (abs > 0 && abs < 0.01) return `${sign}<${cur === 'CHF' ? 'CHF ' : '$'}0.01`;
  let decimals = opts.decimals ?? (abs >= 1000 ? 0 : 2);
  let body: string;
  if (opts.compact && abs >= 1_000_000) {
    body = `${groupSwiss((abs / 1_000_000).toFixed(2))}M`;
    decimals = 2;
  } else if (opts.compact && abs >= 10_000) {
    body = `${groupSwiss((abs / 1000).toFixed(1))}k`;
    decimals = 1;
  } else body = groupSwiss(abs.toFixed(decimals));
  if (cur === 'CHF') return `${sign}CHF ${body}${decimals === 0 && !opts.compact ? '.-' : ''}`;
  return `${sign}$${body}`;
}

/** Currency prefix / suffix for big KPI numbers rendered in parts. */
export function moneyParts(usd: number, cur: Currency, rate: number | null): { prefix: string; body: string; suffix: string } {
  if (stealthOn) return { prefix: cur === 'CHF' ? 'CHF ' : '$', body: MASK, suffix: '' };
  const v = cur === 'CHF' && rate ? usd * rate : usd;
  const neg = v < 0 ? '-' : '';
  const body = groupSwiss(Math.abs(v).toFixed(0));
  return cur === 'CHF' ? { prefix: `${neg}CHF `, body, suffix: '.-' } : { prefix: `${neg}$`, body, suffix: '' };
}

/**
 * Token amount: 4 significant decimals, apostrophe thousands, and DeBank-style subscript zeros for
 * tiny amounts (0.0000003174 -> 0.0₆3174, the subscript counts the zeros after the decimal point).
 */
export function fmtAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  if (stealthOn) return MASK;
  return amountText(n);
}

function amountText(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return sign + groupSwiss(abs.toFixed(2));
  if (abs >= 1) return sign + groupSwiss(abs.toFixed(4).replace(/\.?0+$/, ''));
  const zeros = Math.floor(-Math.log10(abs)); // zeros after the decimal point
  if (zeros >= 4) {
    const digits = Math.round(abs * 10 ** (zeros + 4)).toString().slice(0, 4).replace(/0+$/, '');
    const sub = String(zeros).split('').map((d) => SUB[Number(d)]).join('');
    return `${sign}0.0${sub}${digits}`;
  }
  return sign + abs.toFixed(zeros + 4).replace(/0+$/, '');
}

/** Price per unit: like money but keeps significant digits for sub-cent prices. */
export function fmtPrice(usd: number | null | undefined, cur: Currency, rate: number | null, decimals = 2): string {
  if (usd == null || !Number.isFinite(usd)) return '-';
  const v = cur === 'CHF' && rate ? usd * rate : usd;
  const pre = cur === 'CHF' ? 'CHF ' : '$';
  if (Math.abs(v) >= 1) return pre + groupSwiss(v.toFixed(Math.abs(v) >= 1000 ? Math.min(decimals, 2) : 2));
  return pre + amountText(v);
}

export function fmtPct(f: number | null | undefined, decimals = 2): string {
  if (f == null || !Number.isFinite(f)) return '-';
  const p = f * 100;
  return `${p > 0 ? '+' : ''}${p.toFixed(decimals)}%`;
}

/** Unsigned percentage for shares, rates and ratios (0.594 -> 59.4%). */
export function fmtShare(f: number | null | undefined, decimals = 1): string {
  if (f == null || !Number.isFinite(f)) return '-';
  return `${(f * 100).toFixed(decimals)}%`;
}

/** Asset quantity for exposure lines: 2 decimals above 1, more below, Swiss grouping. */
export function fmtUnits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '-';
  if (stealthOn) return MASK;
  const abs = Math.abs(n);
  if (abs >= 1) return groupSwiss(n.toFixed(abs >= 10_000 ? 0 : 2));
  return amountText(n);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** dd.mm.yyyy (local time) from unix seconds. */
export function fmtDate(ts: number | null | undefined): string {
  if (ts == null) return '-';
  const d = new Date(ts * 1000);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** dd.mm.yyyy of the UTC day (daily snapshots are UTC days). */
export function fmtUtcDate(ts: number | null | undefined): string {
  if (ts == null) return '-';
  const d = new Date(ts * 1000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (ts == null) return '-';
  const d = new Date(ts * 1000);
  return `${fmtDate(ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtAgo(ts: number | null | undefined, now = Date.now() / 1000): string {
  if (ts == null) return 'never';
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function shortAddr(a: string | null | undefined): string {
  if (!a) return '-';
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function fmtHf(hf: number | null | undefined, hasDebt = true): string {
  if (hf == null || !Number.isFinite(hf)) return hasDebt ? '-' : '∞';
  return hf >= 100 ? '>100' : hf.toFixed(2);
}

export const CHAIN_LABEL: Record<string, string> = { ethereum: 'Ethereum', arbitrum: 'Arbitrum' };
export const CHAIN_COLOR: Record<string, string> = { ethereum: 'var(--oc)', arbitrum: 'var(--ccr)' };
export const PROTOCOL_LABEL: Record<string, string> = { wallet: 'Wallet', 'aave-v3': 'Aave V3' };
export const MARKET_LABEL: Record<string, string> = {
  'eth-core': 'Aave V3 Core',
  'eth-prime': 'Aave V3 Prime',
  'eth-etherfi': 'Aave V3 EtherFi',
  'eth-horizon': 'Aave V3 Horizon',
  'arb-core': 'Aave V3 Arbitrum',
};
export const SERIES_COLORS = ['var(--ccr)', 'var(--oc)', 'var(--tag)', 'var(--c4)', 'var(--c5)', 'var(--neutral)'];

/** Health factor meter fill 0..1 (1.0 = liquidation, 3+ = full). */
export function hfFill(hf: number | null): number {
  if (hf == null) return 1;
  return Math.max(0, Math.min(1, (hf - 1) / 2));
}

export function hfTone(hf: number | null): 'ok' | 'warn' | 'danger' {
  if (hf == null || hf >= 1.5) return 'ok';
  if (hf >= 1.15) return 'warn';
  return 'danger';
}
