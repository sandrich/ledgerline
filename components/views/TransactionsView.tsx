'use client';
// /transactions: the ledger of a scope (overview, a wallet or one address), newest first, grouped by
// day. Filters: kind group, chain, hide internal transfers, include spam. "Load more" follows the
// API cursor.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Chain, TransactionsResponse, TxKind, TxRow, WalletsResponse } from '../../lib/queries/api-types';
import { fmtDate, fmtMoney, fmtUtcDate, shortAddr } from '../format';
import { useApi, useApp } from '../layout/Providers';
import { TxEmpty, TxRowItem } from '../tx/TxList';
import { Hero } from './parts';

const KIND_GROUPS: { key: string; label: string; kinds: TxKind[] | null }[] = [
  { key: 'all', label: 'All', kinds: null },
  { key: 'transfers', label: 'Transfers', kinds: ['receive', 'send'] },
  { key: 'internal', label: 'Internal', kinds: ['internal'] },
  { key: 'swap', label: 'Swaps', kinds: ['swap'] },
  { key: 'aave', label: 'Aave', kinds: ['aave-supply', 'aave-withdraw', 'aave-borrow', 'aave-repay'] },
  { key: 'curve', label: 'Curve', kinds: ['curve-borrow', 'curve-repay', 'curve-deposit', 'curve-withdraw'] },
  { key: 'approval', label: 'Approvals', kinds: ['approval'] },
  { key: 'other', label: 'Other', kinds: ['other'] },
];

function validScope(s: string | null): string {
  if (!s) return 'all';
  if (s === 'all' || /^wallet:\d+$/.test(s) || /^address:0x[0-9a-fA-F]{40}$/.test(s)) return s;
  return 'all';
}

function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function TransactionsView() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { currency, rate, refreshTick, stealth } = useApp();
  const scope = validScope(params.get('scope'));
  const { data: wallets } = useApi<WalletsResponse>('/api/wallets');

  const [group, setGroup] = useState('all');
  const [chain, setChain] = useState<Chain | 'all'>('all');
  const [hideInternal, setHideInternal] = useState(false);
  const [includeSpam, setIncludeSpam] = useState(false);
  // approvals and zero value contract calls are hidden by the API unless asked for
  const [includeApprovals, setIncludeApprovals] = useState(false);
  const [items, setItems] = useState<TxRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [first, setFirst] = useState<TransactionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);

  const baseUrl = useMemo(() => {
    const q = new URLSearchParams({ scope, limit: '50' });
    const g = KIND_GROUPS.find((k) => k.key === group);
    if (g?.kinds) q.set('kind', g.kinds.join(','));
    if (chain !== 'all') q.set('chain', chain);
    if (hideInternal) q.set('hideInternal', '1');
    if (includeSpam) q.set('includeSpam', '1');
    if (includeApprovals) q.set('includeApprovals', '1');
    return `/api/transactions?${q.toString()}`;
  }, [scope, group, chain, hideInternal, includeSpam, includeApprovals]);

  const load = useCallback(
    async (cur: string | null) => {
      const my = cur ? gen.current : ++gen.current;
      if (cur) setMore(true);
      else setLoading(true);
      try {
        const r = await fetch(cur ? `${baseUrl}&cursor=${encodeURIComponent(cur)}` : baseUrl, { cache: 'no-store' });
        const j = (await r.json().catch(() => null)) as TransactionsResponse | { error?: string } | null;
        if (my !== gen.current) return;
        if (!r.ok || !j || !('items' in j)) {
          setError((j && 'error' in j && j.error) || `Request failed (${r.status})`);
          return;
        }
        setError(null);
        setItems((prev) => (cur ? [...prev, ...j.items] : j.items));
        setCursor(j.nextCursor);
        if (!cur) setFirst(j);
      } catch {
        if (my === gen.current) setError('Could not reach the server');
      } finally {
        if (my === gen.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [baseUrl],
  );

  useEffect(() => {
    void load(null);
  }, [load, refreshTick]);

  const setScope = (s: string) => {
    const q = new URLSearchParams(params.toString());
    if (s === 'all') q.delete('scope');
    else q.set('scope', s);
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const walletList = wallets?.wallets ?? [];
  const scopeLabel = (() => {
    if (scope === 'all') return 'all wallets';
    if (scope.startsWith('wallet:')) return walletList.find((w) => `wallet:${w.id}` === scope)?.name ?? 'this wallet';
    const addr = scope.slice(8).toLowerCase();
    for (const w of walletList) for (const a of w.addresses) if (a.address.toLowerCase() === addr) return a.label ?? shortAddr(addr);
    return shortAddr(addr);
  })();
  const addressScope = scope.startsWith('address:') ? scope : null;
  const flows = first?.flows ?? null;
  const filtered = group !== 'all' || chain !== 'all' || hideInternal || includeApprovals;

  // group rows by local day
  const days: { key: string; ts: number; rows: TxRow[] }[] = [];
  for (const t of items) {
    const k = dayKey(t.ts);
    const last = days[days.length - 1];
    if (last && last.key === k) last.rows.push(t);
    else days.push({ key: k, ts: t.ts, rows: [t] });
  }

  return (
    <div className="view">
      <Hero
        eyebrow="Activity"
        title="Transactions,"
        em={scope === 'all' ? 'across your wallets' : scopeLabel}
        sub={
          flows && stealth ? (
            `Deposits and withdrawals valued at the time${flows.sinceTs != null ? ` since ${fmtUtcDate(flows.sinceTs)}` : ''}. Moves between your own addresses are recognised as internal transfers.`
          ) : flows ? (
            <>
              {fmtMoney(flows.depositsUsd, currency, rate, { compact: true })} deposited and {fmtMoney(flows.withdrawalsUsd, currency, rate, { compact: true })} withdrawn
              {flows.sinceTs != null ? ` since ${fmtUtcDate(flows.sinceTs)}` : ''}, valued at the time.{' '}
              {scope.startsWith('wallet:') || addressScope ? 'Transfers with your other wallets count as deposits and withdrawals here.' : 'Moves between your own addresses are internal and never count.'}
            </>
          ) : (
            'Transfers, swaps and Aave actions of your addresses. Moves between your own addresses are recognised as internal transfers.'
          )
        }
      />

      {flows && (
        <div className="flow-strip" role="list">
          <div role="listitem">
            <small>Deposits</small>
            <b className="num pos">{fmtMoney(flows.depositsUsd, currency, rate, { sign: true, decimals: 0 })}</b>
          </div>
          <div role="listitem">
            <small>Withdrawals</small>
            <b className="num neg">{fmtMoney(-flows.withdrawalsUsd, currency, rate, { sign: true, decimals: 0 })}</b>
          </div>
          <div role="listitem">
            <small>Net deposits</small>
            <b className="num">{fmtMoney(flows.netDepositsUsd, currency, rate, { sign: true, decimals: 0 })}</b>
          </div>
          <div role="listitem">
            <small>Since</small>
            <b className="num">{flows.sinceTs != null ? fmtDate(flows.sinceTs) : '-'}</b>
          </div>
        </div>
      )}

      <div className="tx-toolbar">
        <label className="field scope-field">
          <span className="sr-only">Scope</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
            <option value="all">All wallets</option>
            {walletList.map((w) => (
              <option key={w.id} value={`wallet:${w.id}`}>
                {w.name}
              </option>
            ))}
            {addressScope && <option value={addressScope}>{scopeLabel}</option>}
          </select>
        </label>
        <div className="chips kind-chips" role="radiogroup" aria-label="Kind">
          {KIND_GROUPS.map((g) => (
            <label key={g.key} className={`chip small${group === g.key ? ' on' : ''}`}>
              <input className="sr-only" type="radio" name="tx-kind" value={g.key} checked={group === g.key} onChange={() => setGroup(g.key)} />
              {g.label}
            </label>
          ))}
        </div>
        <div className="tx-toolbar-right">
          <div className="seg small-seg" role="radiogroup" aria-label="Chain">
            {(['all', 'ethereum', 'arbitrum'] as const).map((c) => (
              <label key={c}>
                <input type="radio" name="tx-chain" value={c} checked={chain === c} onChange={() => setChain(c)} />
                {c === 'all' ? 'All chains' : c === 'ethereum' ? 'Ethereum' : 'Arbitrum'}
              </label>
            ))}
          </div>
          <label className="toggle">
            <input type="checkbox" checked={hideInternal} onChange={(e) => setHideInternal(e.target.checked)} />
            Hide internal
          </label>
          <label className="toggle" title="Token approvals and contract calls that move no tokens">
            <input type="checkbox" checked={includeApprovals} onChange={(e) => setIncludeApprovals(e.target.checked)} />
            Show approvals
          </label>
          <label className="toggle">
            <input type="checkbox" checked={includeSpam} onChange={(e) => setIncludeSpam(e.target.checked)} />
            Include spam
          </label>
        </div>
      </div>

      <section className="card span-12 tx-card" aria-busy={loading}>
        {loading && !items.length ? (
          <div className="tx-loading">
            <div className="skeleton tx-skeleton" />
            <div className="skeleton tx-skeleton" />
          </div>
        ) : error && !items.length ? (
          <div className="card-error">
            <i className="ph ph-warning-circle" aria-hidden="true" />
            <div>
              <b>Transactions unavailable</b>
              <span>{error}</span>
            </div>
            <button className="btn" type="button" onClick={() => void load(null)}>
              Retry
            </button>
          </div>
        ) : !items.length ? (
          <TxEmpty syncing={!!first?.syncing} filtered={filtered || includeSpam} />
        ) : (
          <>
            {first?.syncing && (
              <div className="tx-sync-note" role="status">
                <span className="spin" aria-hidden="true" />
                The ledger is still syncing, older transactions may be missing.
              </div>
            )}
            <div className={loading ? 'tx-days refreshing' : 'tx-days'}>
              {days.map((d) => (
                <div key={d.key} className="tx-day">
                  <h4 className="tx-day-head">
                    {fmtDate(d.ts)}
                    <span className="muted small">
                      {d.rows.length} transaction{d.rows.length === 1 ? '' : 's'}
                    </span>
                  </h4>
                  <ul className="tx-list">
                    {d.rows.map((t) => (
                      <TxRowItem key={t.id} row={t} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <div className="table-foot">
              <span>
                <span className="num">{items.length}</span> transaction{items.length === 1 ? '' : 's'} shown
                {!includeSpam && !includeApprovals ? ', spam and approvals hidden' : !includeSpam ? ', spam hidden' : !includeApprovals ? ', approvals hidden' : ''}
              </span>
              {cursor ? (
                <button className="btn" type="button" onClick={() => void load(cursor)} disabled={more}>
                  <i className={`ph ${more ? 'ph-circle-notch spin-icon' : 'ph-caret-down'}`} aria-hidden="true" />
                  Load more
                </button>
              ) : (
                <span className="muted">End of history</span>
              )}
            </div>
          </>
        )}
      </section>
      {scope !== 'all' && (
        <p className="tx-back">
          <Link className="link" href={scope.startsWith('wallet:') ? `/wallets/${scope.slice(7)}` : `/address/${scope.slice(8)}`}>
            <i className="ph ph-arrow-left" aria-hidden="true" /> Back to {scopeLabel}
          </Link>
        </p>
      )}
    </div>
  );
}
