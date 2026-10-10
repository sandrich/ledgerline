'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { HealthResponse } from '../../lib/queries/api-types';
import { CURRENCIES, fmtAgo, type Currency } from '../format';
import { apiSend, useApi, useApp } from './Providers';

export function TopBar() {
  const path = usePathname() ?? '/';
  const { currency, setCurrency, available, toast, bump, stealth, setStealth } = useApp();
  const { data: health } = useApi<HealthResponse>('/api/health', { pollMs: 30_000 });
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const scope = path.startsWith('/wallets/') ? `wallet:${path.split('/')[2]}` : path.startsWith('/address/') ? `address:${path.split('/')[2]}` : 'all';
  const sync = async () => {
    setBusy(true);
    try {
      await apiSend('/api/sync', 'POST', { scope });
      toast('Sync queued, the worker picks it up within a few seconds');
      setTimeout(bump, 8000);
      setTimeout(bump, 25000);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Sync failed', 'err');
    } finally {
      setBusy(false);
    }
  };

  const overviewActive = path === '/';
  const walletsActive = path.startsWith('/wallets');
  const activityActive = path.startsWith('/transactions');
  const stale = health?.workerHeartbeatAt != null && Date.now() / 1000 - health.workerHeartbeatAt > 120;

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link className="brand" href="/" aria-label="ledgerline home">
          <span className="brand-mark" aria-hidden="true">
            {/* public/brand/ledgerline-mark.svg, inlined so it follows the app theme (data-theme) */}
            <svg viewBox="0 0 64 64" width="30" height="30" focusable="false">
              <rect className="lm-tile" x="2" y="2" width="60" height="60" rx="16" strokeWidth="2" />
              <path className="lm-rule" d="M15 23H49M15 33H49M15 43H49" strokeWidth="3" strokeLinecap="round" fill="none" />
              <path className="lm-line" d="M15 44.5 L25.5 36.5 L33 39.5 L46.5 23.5" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <circle className="lm-halo" cx="46.5" cy="23.5" r="7" />
              <circle className="lm-dot" cx="46.5" cy="23.5" r="4.5" />
            </svg>
          </span>
          <span className="brand-name">ledgerline</span>
        </Link>
        <nav className="nav" aria-label="Views">
          <Link href="/" title="Overview" className={overviewActive ? 'active' : undefined} aria-current={path === '/' ? 'page' : undefined}>
            <i className="ph ph-squares-four" aria-hidden="true" />
            <span className="nav-label">Overview</span>
          </Link>
          <Link href="/wallets" title="Wallets" className={walletsActive ? 'active' : undefined} aria-current={walletsActive ? 'page' : undefined}>
            <i className="ph ph-wallet" aria-hidden="true" />
            <span className="nav-label">Wallets</span>
          </Link>
          <Link href="/transactions" title="Activity" className={activityActive ? 'active' : undefined} aria-current={activityActive ? 'page' : undefined}>
            <i className="ph ph-arrows-down-up" aria-hidden="true" />
            <span className="nav-label">Activity</span>
          </Link>
        </nav>
        <div className="topbar-right">
          <span className={`db-hint${stale ? ' stale' : ''}`} title={stale ? 'The worker has not reported for a while' : 'Last live snapshot'}>
            {stale ? 'worker offline, ' : ''}last snapshot {fmtAgo(health?.lastSnapshotAt ?? null)}
          </span>
          <button
            type="button"
            className={`icon-btn stealth-btn${stealth ? ' on' : ''}`}
            onClick={() => setStealth(!stealth)}
            aria-pressed={stealth}
            aria-label={stealth ? 'Show amounts (h)' : 'Hide amounts (h)'}
            title={stealth ? 'Show amounts (h)' : 'Hide amounts (h)'}
          >
            <i className={`ph ${stealth ? 'ph-eye-slash' : 'ph-eye'}`} aria-hidden="true" />
          </button>
          <select className="cur-select" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)} aria-label="Currency">
            {CURRENCIES.map((c) => (
              <option key={c} value={c} disabled={!available(c)}>
                {c}
              </option>
            ))}
          </select>
          <div className="seg cur-seg" role="radiogroup" aria-label="Currency">
            {CURRENCIES.map((c) => (
              <label key={c} className={available(c) ? undefined : 'off'} title={available(c) ? undefined : `No USD/${c} rates synced yet`}>
                <input type="radio" name="currency" value={c} checked={currency === c} disabled={!available(c)} onChange={() => setCurrency(c)} />
                {c}
              </label>
            ))}
          </div>
          <button className="btn btn-primary" type="button" onClick={sync} disabled={busy} aria-label="Sync now">
            <i className={`ph ${busy ? 'ph-circle-notch spin-icon' : 'ph-arrows-clockwise'}`} aria-hidden="true" />
            <span>Sync now</span>
          </button>
        </div>
      </div>
    </header>
  );
}
