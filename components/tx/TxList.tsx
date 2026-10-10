'use client';
// Transactions ledger UI: one row per transaction with kind, chain, signed token legs (value at the
// time), counterparty (own wallets as badges) and an explorer link. Internal transfers between own
// addresses are neutral and show both own badges with an arrow.
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { TransactionsResponse, TxKind, TxRow } from '../../lib/queries/api-types';
import { CHAIN_LABEL, fmtAmount, fmtDate, fmtMoney, shortAddr } from '../format';
import { useApi, useApp } from '../layout/Providers';

export const KIND_META: Record<TxKind, { label: string; icon: string; tone: 'in' | 'out' | 'neutral' | 'aave' | 'muted' }> = {
  receive: { label: 'Receive', icon: 'ph-arrow-down-left', tone: 'in' },
  send: { label: 'Send', icon: 'ph-arrow-up-right', tone: 'out' },
  internal: { label: 'Internal transfer', icon: 'ph-arrows-left-right', tone: 'neutral' },
  swap: { label: 'Swap', icon: 'ph-swap', tone: 'neutral' },
  'aave-supply': { label: 'Aave Supply', icon: 'ph-tray-arrow-down', tone: 'aave' },
  'aave-withdraw': { label: 'Aave Withdraw', icon: 'ph-tray-arrow-up', tone: 'aave' },
  'aave-borrow': { label: 'Aave Borrow', icon: 'ph-hand-coins', tone: 'aave' },
  'aave-repay': { label: 'Aave Repay', icon: 'ph-arrow-u-up-left', tone: 'aave' },
  approval: { label: 'Approval', icon: 'ph-seal-check', tone: 'muted' },
  spam: { label: 'Spam', icon: 'ph-warning', tone: 'muted' },
  other: { label: 'Contract call', icon: 'ph-dots-three-outline', tone: 'muted' },
};

/** variableDebtUSDC -> "USDC debt" */
export function displaySymbol(sym: string): string {
  const m = /^(?:variable|stable)Debt(?:Arb|Eth)?(.+)$/i.exec(sym);
  return m ? `${m[1]} debt` : sym;
}

export interface Leg {
  key: string;
  symbol: string;
  /** a debt token: more of it is worse */
  debt: boolean;
  /** signed: + into the scope, - out of it */
  amount: number;
  usd: number | null;
}

export interface InternalLeg {
  from: string;
  to: string;
  symbol: string;
  amount: number;
  usd: number | null;
}

/** Net token movement of a transaction for the scope (flash loans and routing cancel out), plus the internal legs. */
export function summarize(row: TxRow): { legs: Leg[]; internal: InternalLeg[]; own: Leg[] } {
  const acc = new Map<string, { symbol: string; net: number; gross: number; usd: number; usdAmt: number; priced: boolean }>();
  const internal: InternalLeg[] = [];
  // transfers with an own address outside the scope, gross (shown when the net cancels out, e.g. a
  // Safe that receives from and pays back to its owner within one transaction)
  const own: Leg[] = [];
  for (const t of row.transfers) {
    if (t.direction !== 'internal' && t.fromOwn && t.toOwn) {
      const sign = t.direction === 'in' ? 1 : -1;
      own.push({ key: `o${own.length}`, symbol: displaySymbol(t.symbol), debt: false, amount: sign * t.amount, usd: t.usd != null ? sign * t.usd : null });
    }
    if (t.direction === 'internal') {
      internal.push({ from: t.fromLabel ?? shortAddr(t.from), to: t.toLabel ?? shortAddr(t.to), symbol: displaySymbol(t.symbol), amount: t.amount, usd: t.usd });
      continue;
    }
    const k = `${t.token}:${t.symbol}`;
    const a = acc.get(k) ?? { symbol: displaySymbol(t.symbol), net: 0, gross: 0, usd: 0, usdAmt: 0, priced: false };
    a.net += t.direction === 'in' ? t.amount : -t.amount;
    a.gross += t.amount;
    if (t.usd != null) {
      a.usd += t.usd;
      a.usdAmt += t.amount;
      a.priced = true;
    }
    acc.set(k, a);
  }
  const legs: Leg[] = [];
  for (const [k, a] of acc) {
    if (Math.abs(a.net) <= Math.max(1e-12, a.gross * 1e-6)) continue;
    const unit = a.priced && a.usdAmt > 0 ? a.usd / a.usdAmt : null;
    const usd = unit != null ? unit * a.net : null;
    if (usd != null && Math.abs(usd) < 0.005 && a.gross > 0 && Math.abs(a.net) / a.gross < 0.01) continue;
    legs.push({ key: k, symbol: a.symbol, debt: a.symbol.endsWith(' debt'), amount: a.net, usd });
  }
  legs.sort((x, y) => Math.abs(y.usd ?? 0) - Math.abs(x.usd ?? 0));
  return { legs, internal, own };
}

function OwnBadge({ children }: { children: ReactNode }) {
  return (
    <span className="own-badge">
      <i className="ph ph-wallet" aria-hidden="true" />
      {children}
    </span>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function TxRowItem({ row, compact = false }: { row: TxRow; compact?: boolean }) {
  const { currency, rateAt } = useApp();
  const meta = KIND_META[row.kind] ?? KIND_META.other;
  const { legs, internal, own } = summarize(row);
  const r = currency === 'CHF' ? rateAt(row.ts) : 1;
  const money = (v: number | null, sign = false) => fmtMoney(v, currency, r, { sign, compact: true });
  const d = new Date(row.ts * 1000);
  const firstInternal = internal[0];

  let detail: ReactNode;
  if (row.kind === 'internal' && firstInternal) {
    detail = (
      <span className="tx-path">
        <OwnBadge>{firstInternal.from}</OwnBadge>
        <i className="ph ph-arrow-right" aria-hidden="true" />
        <OwnBadge>{firstInternal.to}</OwnBadge>
      </span>
    );
  } else if (row.counterpartyLabel) {
    detail = (
      <span className="tx-path">
        {row.kind === 'receive' ? 'from' : row.kind === 'send' ? 'to' : 'with'} <OwnBadge>{row.counterpartyLabel}</OwnBadge>
      </span>
    );
  } else if (row.counterparty) {
    detail = (
      <span className="tx-path">
        {row.kind === 'receive' ? 'from' : row.kind === 'send' ? 'to' : 'with'} <span className="num">{shortAddr(row.counterparty)}</span>
      </span>
    );
  } else if (firstInternal) {
    detail = (
      <span className="tx-path">
        <OwnBadge>{firstInternal.from}</OwnBadge>
        <i className="ph ph-arrow-right" aria-hidden="true" />
        <OwnBadge>{firstInternal.to}</OwnBadge>
      </span>
    );
  } else detail = <span className="tx-path muted">{row.kind === 'approval' ? 'token allowance' : row.kind === 'other' ? 'no token movement' : ''}</span>;

  // internal transfers have no signed legs: show the moved amounts neutrally
  // a send/receive with an own wallet leads with what actually moved to or from that wallet, since
  // inside a batch (e.g. a position close that pays out to the owner) that token can net to zero
  const ownFlow = (row.kind === 'send' || row.kind === 'receive') && row.counterpartyLabel != null && own.length > 0;
  const signedLegs = ownFlow
    ? [...own, ...legs.filter((l) => !own.some((o) => o.symbol === l.symbol))]
    : legs.length
      ? legs
      : own;
  const lines: { key: string; text: string; usd: number | null; tone: 'pos' | 'neg' | 'neu' }[] =
    row.kind === 'internal' || (!signedLegs.length && internal.length)
      ? internal.map((l, i) => ({ key: `i${i}`, text: `${fmtAmount(l.amount)} ${l.symbol}`, usd: l.usd, tone: 'neu' as const }))
      : signedLegs.map((l) => ({ key: l.key, text: `${l.amount > 0 ? '+' : '-'}${fmtAmount(Math.abs(l.amount))} ${l.symbol}`, usd: l.usd, tone: l.amount > 0 !== l.debt ? ('pos' as const) : ('neg' as const) }));
  const maxLines = compact ? 2 : 4;
  const more = lines.length - maxLines;

  const moved = row.kind === 'internal' ? internal.reduce((s, l) => s + (l.usd ?? 0), 0) : null;
  const flowKind = row.kind === 'receive' || row.kind === 'send' || row.kind === 'other';
  let value: ReactNode;
  if (flowKind && row.netUsd != null && Math.abs(row.netUsd) >= 0.005) {
    value = <b className={`num ${row.netUsd < 0 ? 'neg' : 'pos'}`}>{money(row.netUsd, true)}</b>;
  } else if (moved != null && moved > 0) {
    value = (
      <b className="num neu" title="Moved between your own addresses, not a deposit or withdrawal">
        {money(moved)}
      </b>
    );
  } else {
    const big = legs.reduce((m, l) => Math.max(m, Math.abs(l.usd ?? 0)), 0);
    value = big > 0 ? <b className="num neu">{money(big)}</b> : <b className="muted">-</b>;
  }

  return (
    <li className={`tx-row tone-${meta.tone}${row.kind === 'internal' ? ' is-internal' : ''}${compact ? ' compact' : ''}`}>
      <span className="tx-when" title={`${fmtDate(row.ts)} ${pad(d.getHours())}:${pad(d.getMinutes())}`}>
        {compact ? (
          <>
            <b className="num">
              {pad(d.getDate())}.{pad(d.getMonth() + 1)}
              <small>.{String(d.getFullYear()).slice(2)}</small>
            </b>
            <span className="num">
              {pad(d.getHours())}:{pad(d.getMinutes())}
            </span>
          </>
        ) : (
          <b className="num">
            {pad(d.getHours())}:{pad(d.getMinutes())}
          </b>
        )}
      </span>
      <span className="tx-kind">
        <span className="tx-icon" aria-hidden="true">
          <i className={`ph ${meta.icon}`} />
        </span>
        <span className="tx-kind-text">
          <b>
            {meta.label}
            <span className={`chain-badge chain-${row.chain}`}>{CHAIN_LABEL[row.chain] ?? row.chain}</span>
          </b>
          {detail}
        </span>
      </span>
      <span className="tx-legs">
        {lines.slice(0, maxLines).map((l) => (
          <span key={l.key} className={`tx-leg ${l.tone}`}>
            <span className="num">{l.text}</span>
            {l.usd != null && <small className="num">{money(Math.abs(l.usd))}</small>}
          </span>
        ))}
        {more > 0 && <span className="tx-leg more">+{more} more</span>}
        {!lines.length && <span className="tx-leg muted empty-leg">-</span>}
      </span>
      <span className="tx-val">
        {value}
        {!compact && row.feeUsd != null && row.feeUsd > 0 && <small className="num">fee {fmtMoney(row.feeUsd, currency, r)}</small>}
      </span>
      <a className="tx-link icon-btn" href={row.explorerUrl} target="_blank" rel="noreferrer" aria-label={`Open ${row.hash.slice(0, 10)} in the block explorer`} title="Open in explorer">
        <i className="ph ph-arrow-square-out" aria-hidden="true" />
      </a>
    </li>
  );
}

/** Compact "Recent activity" card: the 5 newest transactions of a scope and a link to the full list. */
export function RecentActivity({ scope, className = 'card span-12' }: { scope: string; className?: string }) {
  // approvals and bare contract calls are noise in a 5 row summary; the full list has them
  const kinds = 'receive,send,internal,swap,aave-supply,aave-withdraw,aave-borrow,aave-repay';
  const { data, error, loading } = useApi<TransactionsResponse>(`/api/transactions?scope=${encodeURIComponent(scope)}&limit=5&kind=${kinds}`, { pollMs: 120_000 });
  const href = scope === 'all' ? '/transactions' : `/transactions?scope=${encodeURIComponent(scope)}`;
  return (
    <section className={`${className} activity-card`}>
      <div className="card-head">
        <h3>
          <i className="ph ph-arrows-down-up" aria-hidden="true" />
          Recent activity
        </h3>
        <Link className="link" href={href}>
          All transactions <i className="ph ph-arrow-right" aria-hidden="true" />
        </Link>
      </div>
      {loading ? (
        <div className="skeleton tx-skeleton" aria-label="Loading transactions" />
      ) : error && !data ? (
        <div className="empty slim">Transactions unavailable: {error}</div>
      ) : !data?.items.length ? (
        <TxEmpty syncing={!!data?.syncing} />
      ) : (
        <ul className="tx-list">
          {data.items.map((t) => (
            <TxRowItem key={t.id} row={t} compact />
          ))}
        </ul>
      )}
    </section>
  );
}

export function TxEmpty({ syncing, filtered = false }: { syncing: boolean; filtered?: boolean }) {
  return syncing ? (
    <div className="empty slim tx-empty">
      <span className="spin" aria-hidden="true" />
      <b>Reading the transaction history</b>
      The ledger is still syncing from the chain, transactions appear here as they are found.
    </div>
  ) : (
    <div className="empty slim tx-empty">
      <i className="ph ph-tray" aria-hidden="true" />
      <b>{filtered ? 'No transactions match these filters' : 'No transactions yet'}</b>
      {filtered ? 'Try another kind or chain, or include spam.' : 'Transfers, swaps and Aave actions of your addresses show up here.'}
    </div>
  );
}

