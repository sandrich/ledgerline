'use client';
// /wallets: create / rename / delete wallets, add / remove addresses (label, chains), exclude from
// totals, trigger a sync, backfill progress per address.
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AddressSummary, Chain, WalletWithAddresses, WalletsResponse } from '../../lib/queries/api-types';
import { CHAIN_LABEL, fmtMoney, shortAddr } from '../format';
import { apiSend, useApi, useApp } from '../layout/Providers';
import { ErrorCard, Hero, PageSkeleton, backfillText } from './parts';

const COLORS = ['#ea5a1f', '#2f2c27', '#c4920f', '#4f8a3e', '#c94343', '#5b6fb5'];
const CHAINS: Chain[] = ['ethereum', 'arbitrum'];

function useMutate() {
  const { toast, bump } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
      bump();
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Request failed', 'err');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function ConfirmButton({ label, confirmLabel, onConfirm, icon }: { label: string; confirmLabel: string; onConfirm: () => void; icon: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn btn-danger${armed ? ' on' : ''}`}
      type="button"
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
      aria-label={armed ? confirmLabel : label}
    >
      <i className={`ph ${icon}`} aria-hidden="true" />
      <span>{armed ? confirmLabel : label}</span>
    </button>
  );
}

function NewWallet({ autoFocus, onDone }: { autoFocus: boolean; onDone: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const { busy, run } = useMutate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await run(() => apiSend('/api/wallets', 'POST', { name: name.trim(), color }), `Wallet "${name.trim()}" created`)) {
      setName('');
      onDone();
    }
  };
  return (
    <form className="card span-12 new-wallet" onSubmit={submit} aria-label="Create wallet">
      <div className="card-head">
        <h3>
          <i className="ph ph-plus-circle" aria-hidden="true" />
          New wallet
        </h3>
        <span className="hint">a named group of addresses</span>
      </div>
      <div className="form-row">
        <label className="field grow">
          Name
          <input ref={ref} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Long term" maxLength={80} required />
        </label>
        <fieldset className="field swatches">
          <legend>Colour</legend>
          <div>
            {COLORS.map((c) => (
              <label key={c} className="swatch" style={{ background: c }}>
                <input type="radio" name="new-color" value={c} checked={color === c} onChange={() => setColor(c)} aria-label={c} />
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
          <i className="ph ph-plus" aria-hidden="true" />
          Add wallet
        </button>
      </div>
    </form>
  );
}

function AddAddress({ walletId }: { walletId: number }) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [chains, setChains] = useState<Chain[]>(['ethereum', 'arbitrum']);
  const { busy, run } = useMutate();
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || !chains.length) return;
    const ok = await run(
      () => apiSend(`/api/wallets/${walletId}/addresses`, 'POST', { address: address.trim(), label: label.trim() || null, chains }),
      'Address added, scanning starts within a few seconds',
    );
    if (ok) {
      setAddress('');
      setLabel('');
    }
  };
  return (
    <form className="add-address" onSubmit={submit} aria-label="Add address">
      <label className="field grow">
        Address
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoComplete="off"
          className="mono-input"
          aria-invalid={address.length > 0 && !valid}
        />
      </label>
      <label className="field">
        Label
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="optional" maxLength={80} />
      </label>
      <fieldset className="field chains-field">
        <legend>Chains</legend>
        <div className="chips">
          {CHAINS.map((c) => (
            <label key={c} className={`chip${chains.includes(c) ? ' on' : ''}`}>
              <input
                type="checkbox"
                className="sr-only"
                checked={chains.includes(c)}
                onChange={(e) => setChains((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))}
              />
              {CHAIN_LABEL[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <button className="btn" type="submit" disabled={busy || !valid || !chains.length}>
        <i className="ph ph-plus" aria-hidden="true" />
        Add address
      </button>
    </form>
  );
}

function AddressRow({ a, walletId }: { a: AddressSummary; walletId: number }) {
  const { currency, rate } = useApp();
  const { busy, run } = useMutate();
  const b = a.backfill;
  const pct = b.totalDays > 0 ? b.doneDays / b.totalDays : b.complete ? 1 : 0;
  const setChains = (c: Chain, on: boolean) => {
    const next = on ? [...new Set([...a.chains, c])] : a.chains.filter((x) => x !== c);
    if (!next.length) return;
    void run(() => apiSend(`/api/addresses/${a.id}`, 'PATCH', { chains: next }), on ? `${CHAIN_LABEL[c]} added` : `${CHAIN_LABEL[c]} removed`);
  };
  return (
    <li className={`addr-row${a.excluded ? ' is-excluded' : ''}`}>
      <div className="addr-main">
        <Link href={`/address/${a.address}`} className="addr-name">
          {a.label ?? shortAddr(a.address)}
        </Link>
        <span className="num muted small" title={a.address}>
          {shortAddr(a.address)}
        </span>
      </div>
      <div className="addr-chains chips">
        {CHAINS.map((c) => (
          <label key={c} className={`chip small${a.chains.includes(c) ? ' on' : ''}`}>
            <input type="checkbox" className="sr-only" checked={a.chains.includes(c)} disabled={busy} onChange={(e) => setChains(c, e.target.checked)} />
            {CHAIN_LABEL[c]}
          </label>
        ))}
      </div>
      <div className="addr-progress">
        <div className={`progress${b.error ? ' warn' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label="History backfill">
          <span style={{ width: `${pct * 100}%` }} />
        </div>
        <span className={`small ${b.error ? 'warn-text' : 'muted'}`}>{backfillText(b)}</span>
      </div>
      <div className="addr-val num">{fmtMoney(a.usd, currency, rate, { decimals: 0 })}</div>
      <div className="addr-actions">
        <label className="toggle" title="Exclude from totals">
          <input
            type="checkbox"
            checked={a.excluded}
            disabled={busy}
            onChange={(e) => void run(() => apiSend(`/api/addresses/${a.id}`, 'PATCH', { excluded: e.target.checked }), e.target.checked ? 'Excluded from totals' : 'Included in totals')}
          />
          <span>Exclude</span>
        </label>
        <button
          className="btn btn-icon"
          type="button"
          disabled={busy}
          aria-label={`Sync ${a.label ?? a.address}`}
          title="Sync now"
          onClick={() => void run(() => apiSend('/api/sync', 'POST', { scope: `address:${a.address}` }), 'Sync queued')}
        >
          <i className="ph ph-arrows-clockwise" aria-hidden="true" />
        </button>
        <ConfirmButton
          label="Remove"
          confirmLabel="Confirm"
          icon="ph-trash"
          onConfirm={() => void run(() => apiSend(`/api/wallets/${walletId}/addresses/${a.id}`, 'DELETE'), 'Address removed')}
        />
      </div>
    </li>
  );
}

function WalletCard({ w }: { w: WalletWithAddresses }) {
  const { currency, rate } = useApp();
  const { busy, run } = useMutate();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(w.name);
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === w.name) return setEditing(false);
    if (await run(() => apiSend(`/api/wallets/${w.id}`, 'PATCH', { name: name.trim() }), 'Wallet renamed')) setEditing(false);
  };
  return (
    <section className={`card span-12 wallet-card${w.excluded ? ' is-excluded' : ''}`} aria-label={`Wallet ${w.name}`}>
      <div className="card-head wallet-head">
        <div className="wallet-title">
          <span className="w-badge" style={{ background: w.color ?? 'var(--accent)' }} aria-hidden="true" />
          {editing ? (
            <form onSubmit={rename} className="rename">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Wallet name" autoFocus maxLength={80} />
              <button className="btn" type="submit" disabled={busy}>
                Save
              </button>
              <button className="btn btn-ghost" type="button" onClick={() => (setName(w.name), setEditing(false))}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h2>
                <Link href={`/wallets/${w.id}`}>{w.name}</Link>
              </h2>
              <button className="icon-btn" type="button" aria-label={`Rename ${w.name}`} onClick={() => setEditing(true)}>
                <i className="ph ph-pencil-simple" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <div className="wallet-meta">
          <span className="num big">{fmtMoney(w.usd, currency, rate, { decimals: 0 })}</span>
          <span className="muted small">
            {w.addressCount} address{w.addressCount === 1 ? '' : 'es'}
          </span>
          <label className="toggle" title="Exclude this wallet from the overview">
            <input
              type="checkbox"
              checked={w.excluded}
              disabled={busy}
              onChange={(e) => void run(() => apiSend(`/api/wallets/${w.id}`, 'PATCH', { excluded: e.target.checked }), e.target.checked ? 'Wallet excluded' : 'Wallet included')}
            />
            <span>Exclude</span>
          </label>
          <ConfirmButton label="Delete" confirmLabel="Delete wallet?" icon="ph-trash" onConfirm={() => void run(() => apiSend(`/api/wallets/${w.id}`, 'DELETE'), 'Wallet deleted')} />
        </div>
      </div>
      {w.addresses.length ? (
        <ul className="addr-list">
          {w.addresses.map((a) => (
            <AddressRow key={a.id} a={a} walletId={w.id} />
          ))}
        </ul>
      ) : (
        <div className="empty slim">No addresses yet. Add one below; history is backfilled from its first on-chain activity.</div>
      )}
      <AddAddress walletId={w.id} />
    </section>
  );
}

export function ManageView() {
  const params = useSearchParams();
  const { data, error, loading, reload } = useApi<WalletsResponse>('/api/wallets', { pollMs: 15_000 });
  const [showNew, setShowNew] = useState(params.get('new') === '1');
  if (loading) return <PageSkeleton />;
  if (error && !data) return <ErrorCard message={error} onRetry={reload} />;
  const wallets = data?.wallets ?? [];
  return (
    <div className="view">
      <Hero
        eyebrow="Wallets"
        title="Wallets and"
        em="addresses"
        sub="Group addresses into wallets. Each address is scanned once on Ethereum and Arbitrum, and its daily history is backfilled from its first on-chain activity."
        right={
          <button className="btn btn-primary" type="button" onClick={() => setShowNew((v) => !v)} aria-expanded={showNew}>
            <i className="ph ph-plus" aria-hidden="true" />
            New wallet
          </button>
        }
      />
      <div className="bento">
        {(showNew || !wallets.length) && <NewWallet autoFocus={showNew} onDone={() => setShowNew(false)} />}
        {wallets.map((w) => (
          <WalletCard key={w.id} w={w} />
        ))}
      </div>
    </div>
  );
}
