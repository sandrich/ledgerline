// Aggregation tests for lib/queries against a temp SQLite database (node:sqlite, no native deps).
// Run: node --experimental-sqlite --import tsx --test lib/queries/__tests__/queries.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { addAddressToWallet, createWallet, enqueueSync, removeAddressFromWallet, updateAddress } from '../../db/repos-api';
import type { QDb } from '../db';
import { buildSeries, downsample, downsampleExtremes, getHistory } from '../history';
import type { HistoryPoint, HistoryRange } from '../api-types';
import { getAddressDetail, getOverview, getWalletDetail } from '../portfolio';
import { parseScope } from '../scope';
import { slicesAt } from '../state';

const DAY = 86_400;
// a fixed "now": 2026-10-09 12:00 UTC
const NOW = Date.UTC(2026, 9, 9, 12) / 1000;
const TODAY = Math.floor(NOW / DAY) * DAY;

const SCHEMA = `
CREATE TABLE wallets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE addresses (id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE, label TEXT, chains TEXT, is_contract TEXT, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE wallet_addresses (wallet_id INTEGER NOT NULL, address_id INTEGER NOT NULL, PRIMARY KEY (wallet_id, address_id));
CREATE TABLE tokens (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT, name TEXT, decimals INTEGER, kind TEXT, underlying TEXT, market TEXT, price_key TEXT, logo TEXT, spam INTEGER DEFAULT 0, PRIMARY KEY (chain, address));
CREATE TABLE address_tokens (address_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, first_block INTEGER, PRIMARY KEY (address_id, chain, token));
CREATE TABLE discovery_state (address_id INTEGER NOT NULL, chain TEXT NOT NULL, last_block INTEGER, start_block INTEGER, start_ts INTEGER, backfill_done_days INTEGER DEFAULT 0, backfill_total_days INTEGER DEFAULT 0, PRIMARY KEY (address_id, chain));
CREATE TABLE blocks (chain TEXT NOT NULL, ts INTEGER NOT NULL, number INTEGER NOT NULL, PRIMARY KEY (chain, ts));
CREATE TABLE prices (price_key TEXT NOT NULL, ts INTEGER NOT NULL, usd REAL NOT NULL, granularity TEXT NOT NULL, PRIMARY KEY (price_key, granularity, ts));
CREATE TABLE fx (day TEXT NOT NULL, currency TEXT NOT NULL, rate_from_usd REAL NOT NULL, PRIMARY KEY (day, currency));
CREATE TABLE snapshots (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE balances (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, protocol TEXT, side TEXT);
CREATE TABLE position_values (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, protocol TEXT NOT NULL, usd REAL NOT NULL);
CREATE INDEX pv_addr ON position_values(address_id, chain, protocol);
CREATE TABLE aave_accounts (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, market TEXT NOT NULL, collateral_usd REAL, debt_usd REAL, health_factor REAL);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, status TEXT, progress INTEGER, total INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const AWETH = '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8';
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const VDUSDC = '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6';
const SPAM = '0x5a5a000000000000000000000000000000005a02';
const NATIVE = '0x0000000000000000000000000000000000000000';

function addr(n: number): string {
  return `0x${n.toString(16).padStart(40, '0')}`;
}

let dir: string;
function openDb(): QDb {
  const d = new DatabaseSync(join(dir, `t${Math.random().toString(36).slice(2)}.db`));
  d.exec(SCHEMA);
  return d as unknown as QDb;
}

function snapshot(db: QDb, kind: 'live' | 'hourly' | 'daily', ts: number): number {
  const r = db.prepare('SELECT id FROM snapshots WHERE kind = ? AND ts = ?').get(kind, ts) as { id: number } | undefined;
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO snapshots (ts, kind) VALUES (?, ?)').run(ts, kind).lastInsertRowid);
}

type Bal = { token: string; amount: number; usd: number; protocol?: string; side?: 'wallet' | 'supply' | 'borrow' };

/** Write one (address, chain) slice: balances + position_values (+ optional aave account). */
function slice(
  db: QDb,
  kind: 'live' | 'hourly' | 'daily',
  ts: number,
  addressId: number,
  chain: string,
  bals: Bal[],
  aave?: { market: string; hf: number; collateral: number; debt: number },
): void {
  const sid = snapshot(db, kind, ts);
  const byProto = new Map<string, number>([['wallet', 0]]);
  for (const b of bals) {
    const protocol = b.protocol ?? 'wallet';
    db.prepare('INSERT INTO balances VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      sid,
      addressId,
      chain,
      b.token,
      String(Math.round(b.amount * 1e6)),
      b.amount,
      b.usd,
      protocol,
      b.side ?? 'wallet',
    );
    byProto.set(protocol, (byProto.get(protocol) ?? 0) + b.usd);
  }
  for (const [p, usd] of byProto) db.prepare('INSERT INTO position_values VALUES (?, ?, ?, ?, ?)').run(sid, addressId, chain, p, usd);
  if (aave) {
    db.prepare('INSERT INTO aave_accounts (snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor) VALUES (?, ?, ?, ?, ?, ?)').run(
      sid,
      addressId,
      aave.market,
      aave.collateral,
      aave.debt,
      aave.hf,
    );
  }
}

function seedTokens(db: QDb): void {
  const ins = db.prepare('INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)');
  ins.run('arbitrum', WETH, 'WETH', 'Wrapped Ether', 18, 'erc20', null, null, 'coingecko:ethereum', 0);
  ins.run('arbitrum', USDC, 'USDC', 'USD Coin', 6, 'erc20', null, null, 'coingecko:usd-coin', 0);
  ins.run('arbitrum', AWETH, 'aArbWETH', 'Aave Arbitrum WETH', 18, 'atoken', WETH, 'arb-core', null, 0);
  ins.run('arbitrum', VDUSDC, 'variableDebtArbUSDCn', 'Aave Arbitrum Variable Debt USDCn', 6, 'vdebt', USDC, 'arb-core', null, 0);
  ins.run('arbitrum', SPAM, 'DeFAI', 'AISweatShop', 18, 'erc20', null, null, null, 0);
  db.prepare("INSERT INTO prices VALUES ('coingecko:ethereum', ?, 2500, 'live')").run(NOW - 600);
  db.prepare("INSERT INTO prices VALUES ('coingecko:usd-coin', ?, 1, 'live')").run(NOW - 600);
}

function insertWallet(db: QDb, name: string, excluded = 0, sort = 0): number {
  return Number(db.prepare('INSERT INTO wallets (name, color, sort, excluded, created_at) VALUES (?, NULL, ?, ?, 0)').run(name, sort, excluded).lastInsertRowid);
}
function insertAddress(db: QDb, n: number, excluded = 0): number {
  return Number(
    db.prepare(`INSERT INTO addresses (address, label, chains, excluded, created_at) VALUES (?, ?, '["ethereum","arbitrum"]', ?, 0)`).run(addr(n), `a${n}`, excluded)
      .lastInsertRowid,
  );
}
function link(db: QDb, w: number, a: number): void {
  db.prepare('INSERT INTO wallet_addresses VALUES (?, ?)').run(w, a);
}

/** Every history point carries assetsUsd / debtUsd with total = assetsUsd - debtUsd. */
function assertAssetsDebt(points: HistoryPoint[]): void {
  for (const p of points) {
    assert.equal(typeof p.assetsUsd, 'number', `assetsUsd missing at ${p.t}`);
    assert.equal(typeof p.debtUsd, 'number', `debtUsd missing at ${p.t}`);
    assert.ok(p.debtUsd! >= 0, `negative debt at ${p.t}`);
    assert.ok(Math.abs(p.total - (p.assetsUsd! - p.debtUsd!)) < 1e-9, `total != assets - debt at ${p.t}`);
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pq-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('overview aggregation', () => {
  test('counts shared addresses once, honours exclusion, byWallet shows full wallet values', () => {
    const db = openDb();
    seedTokens(db);
    const w1 = insertWallet(db, 'Main', 0, 0);
    const w2 = insertWallet(db, 'Family', 0, 1);
    const w3 = insertWallet(db, 'Excluded', 1, 2);
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    const c = insertAddress(db, 3);
    const d = insertAddress(db, 4, 1);
    link(db, w1, a);
    link(db, w2, a); // shared
    link(db, w2, b);
    link(db, w3, c); // only in an excluded wallet
    link(db, w3, a); // a is also in the excluded wallet: still counted
    link(db, w1, d); // excluded address
    for (const [id, usd] of [
      [a, 1000],
      [b, 500],
      [c, 7000],
      [d, 9000],
    ] as const) {
      slice(db, 'live', NOW - 300, id, 'arbitrum', [{ token: WETH, amount: usd / 2500, usd }]);
    }
    const o = getOverview(db, NOW);
    assert.equal(o.totals.netUsd, 1500);
    assert.equal(o.totals.walletUsd, 1500);
    const byW = Object.fromEntries(o.byWallet.map((w) => [w.name, w.usd]));
    assert.deepEqual(byW, { Main: 1000, Family: 1500, Excluded: 8000 });
    assert.equal(o.byChain.find((x) => x.key === 'arbitrum')?.usd, 1500);
    assert.equal(o.lastSnapshotAt, NOW - 300);

    const wd = getWalletDetail(db, w1, NOW)!;
    assert.equal(wd.totals.netUsd, 1000, 'excluded address d is not in the wallet total');
    assert.equal(wd.addresses.length, 2, 'but it is listed');
  });

  test('current state: latest live, else latest completed daily; today daily ignored', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w, a);
    link(db, w, b);
    // a: old live + newer daily (yesterday, effective today 00:00) + newest live
    slice(db, 'live', NOW - 3 * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 10 }]);
    slice(db, 'daily', TODAY - DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 20 }]);
    slice(db, 'live', NOW - 600, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 30 }]);
    // b: only daily backfill so far, including a rollup "today" daily that must not be used yet
    slice(db, 'daily', TODAY - 2 * DAY, b, 'arbitrum', [{ token: WETH, amount: 1, usd: 100 }]);
    slice(db, 'daily', TODAY - DAY, b, 'arbitrum', [{ token: WETH, amount: 1, usd: 200 }]);
    slice(db, 'daily', TODAY, b, 'arbitrum', [{ token: WETH, amount: 1, usd: 999 }]);
    // b on ethereum: live only
    slice(db, 'live', NOW - 900, b, 'ethereum', [{ token: NATIVE, amount: 0.1, usd: 5 }]);
    const s = slicesAt(db, [a, b], NOW);
    assert.equal(s.length, 3);
    const o = getOverview(db, NOW);
    assert.equal(o.totals.netUsd, 30 + 200 + 5);
  });

  test('topTokens aggregates by canonical asset, debt negative, spam hidden; aave summary', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    slice(
      db,
      'live',
      NOW - 60,
      a,
      'arbitrum',
      [
        { token: WETH, amount: 1, usd: 2500 },
        { token: AWETH, amount: 26, usd: 65000, protocol: 'aave-v3', side: 'supply' },
        { token: VDUSDC, amount: 36000, usd: -36000, protocol: 'aave-v3', side: 'borrow' },
        { token: SPAM, amount: 640, usd: 0 },
      ],
      { market: 'arb-core', hf: 1.677, collateral: 65000, debt: 36000 },
    );
    slice(db, 'live', NOW - 60, a, 'ethereum', [{ token: NATIVE, amount: 2, usd: 5000 }]);
    const o = getOverview(db, NOW);
    assert.equal(o.totals.netUsd, 2500 + 65000 - 36000 + 5000);
    assert.equal(o.totals.debtUsd, 36000);
    assert.equal(o.totals.assetsUsd, 72500);
    const eth = o.topTokens.find((t) => t.key === 'coingecko:ethereum')!;
    assert.equal(eth.symbol, 'ETH');
    assert.equal(eth.amount, 29);
    assert.equal(eth.usd, 72500);
    assert.deepEqual(eth.chains, ['arbitrum', 'ethereum']);
    assert.equal(eth.suppliedUsd, 65000);
    assert.equal(eth.walletUsd, 7500);
    const usdc = o.topTokens.find((t) => t.key === 'coingecko:usd-coin')!;
    assert.equal(usdc.usd, -36000);
    assert.equal(usdc.amount, -36000);
    assert.equal(usdc.borrowedUsd, 36000);
    assert.equal(eth.heldAmount, 29);
    assert.equal(eth.borrowedAmount, 0);
    assert.equal(eth.borrowApy, null);
    assert.equal(usdc.heldAmount, 0);
    assert.equal(usdc.borrowedAmount, 36000);
    assert.equal(usdc.borrowApy, null, 'no stored reserve state: borrowApy null');
    assert.ok(!o.topTokens.some((t) => t.symbol === 'DeFAI'), 'unpriced spam is hidden');
    assert.equal(o.topTokens[0].key, 'coingecko:ethereum');
    assert.equal(o.aave.positions.length, 1);
    assert.equal(o.aave.positions[0].healthFactor, 1.677);
    assert.equal(o.aave.lowestHealthFactor, 1.677);
    assert.equal(o.aave.netUsd, 29000);
    const proto = Object.fromEntries(o.byProtocol.map((p) => [p.key, p.usd]));
    assert.deepEqual(proto, { wallet: 7500, 'aave-v3': 29000 });

    const d = getAddressDetail(db, addr(1).toUpperCase().replace('0X', '0x'), NOW)!;
    assert.equal(d.protocols.length, 1);
    assert.equal(d.protocols[0].supplied[0].symbol, 'WETH', 'aToken shown as underlying symbol');
    assert.equal(d.protocols[0].borrowed[0].symbol, 'USDC');
    assert.equal(d.protocols[0].healthFactor, 1.677);
    assert.equal(d.hidden.count, 1);
    assert.equal(d.wallet.tokens.length, 2);
  });

  test('change vs N ago: nearest point at or before, null when missing', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    slice(db, 'live', NOW - DAY - 600, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 800 }]);
    slice(db, 'live', NOW - 60, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 1000 }]);
    const o = getOverview(db, NOW);
    assert.equal(o.change['24h'].abs, 200);
    assert.equal(o.change['24h'].pct, 0.25);
    assert.equal(o.change['7d'].pct, null);
    assert.equal(o.change['7d'].abs, null);
  });

  test('change pct is null when the starting value is dust', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    slice(db, 'live', NOW - DAY - 600, a, 'arbitrum', [{ token: WETH, amount: 0.0000003, usd: 0.0008 }]);
    slice(db, 'live', NOW - 60, a, 'arbitrum', [{ token: WETH, amount: 14, usd: 36000 }]);
    const c = getOverview(db, NOW).change['24h'];
    assert.equal(c.pct, null);
    assert.ok(Math.abs(c.abs! - 35999.9992) < 1e-6);
  });
});

describe('history series', () => {
  test('carry forward per slice, daily dropped when intraday exists that day, groupBy chain sums to total', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w, a);
    link(db, w, b);
    // a: daily for the last 5 days; b: only 2 days backfilled (gap must not dip to 0 on later days)
    for (let i = 5; i >= 1; i--) slice(db, 'daily', TODAY - i * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 100 * i }]);
    slice(db, 'daily', TODAY - 5 * DAY, b, 'ethereum', [{ token: NATIVE, amount: 1, usd: 50 }]);
    slice(db, 'daily', TODAY - 4 * DAY, b, 'ethereum', [{ token: NATIVE, amount: 1, usd: 60 }]);
    // today: live for a, plus a rollup daily for today that must be dropped
    slice(db, 'daily', TODAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 12345 }]);
    slice(db, 'live', TODAY + 3600, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 77 }]);

    const h = getHistory(db, { kind: 'all' }, '7d', 'chain', NOW)!;
    const ts = h.points.map((p) => p.t);
    assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
    assert.ok(!h.points.some((p) => p.total === 12345 + 60), 'today daily dropped in favour of live');
    const at = (t: number) => h.points.find((p) => p.t === t)!;
    assert.equal(at(TODAY - 5 * DAY).total, 550);
    assert.equal(at(TODAY - 4 * DAY).total, 460);
    assert.equal(at(TODAY - 2 * DAY).total, 260, 'b carried forward at 60');
    assert.equal(at(TODAY + 3600).total, 77 + 60);
    for (const p of h.points) {
      const sum = Object.values(p.series).reduce((s, v) => s + v, 0);
      assert.ok(Math.abs(sum - p.total) < 1e-9);
    }
    assert.deepEqual(
      h.keys.map((k) => k.key),
      ['ethereum', 'arbitrum'],
    );

    // 24h range starts with a seed point at `from` carrying the state at that time
    const d = getHistory(db, { kind: 'all' }, '24h', 'none', NOW)!;
    assert.equal(d.points[0].t, NOW - DAY);
    assert.equal(d.points[0].total, 100 + 60);
    assert.equal(d.points[d.points.length - 1].total, 137);
    assertAssetsDebt(h.points);
    assertAssetsDebt(d.points);
    assert.ok(d.points.every((p) => p.debtUsd === 0 && p.assetsUsd === p.total), 'no debt: assets = total');
  });

  test('groupBy wallet attributes a shared address to its first wallet', () => {
    const db = openDb();
    seedTokens(db);
    const w1 = insertWallet(db, 'First', 0, 0);
    const w2 = insertWallet(db, 'Second', 0, 1);
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w1, a);
    link(db, w2, a);
    link(db, w2, b);
    slice(db, 'live', NOW - 600, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 10 }]);
    slice(db, 'live', NOW - 600, b, 'arbitrum', [{ token: WETH, amount: 1, usd: 5 }]);
    const h = getHistory(db, { kind: 'all' }, '24h', 'wallet', NOW)!;
    const last = h.points[h.points.length - 1];
    assert.equal(last.total, 15);
    assert.deepEqual(last.series, { [String(w1)]: 10, [String(w2)]: 5 });
  });

  test('downsamples long series to <= 400 points and keeps the endpoints', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    for (let i = 0; i < 1000; i++) slice(db, 'daily', TODAY - (1000 - i) * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: i }]);
    const h = getHistory(db, { kind: 'all' }, 'all', 'none', NOW)!;
    assert.ok(h.points.length <= 400, `got ${h.points.length}`);
    assert.equal(h.points[0].t, TODAY - 1000 * DAY);
    assert.equal(h.points[h.points.length - 1].total, 999);
    assertAssetsDebt(h.points);
    const s = downsample(
      Array.from({ length: 5000 }, (_, i) => i * 7),
      400,
    );
    assert.ok(s.size <= 400 && s.has(0) && s.has(4999 * 7));
    assert.deepEqual(buildSeries(db, { addressIds: [], from: 0, to: NOW, groupKey: () => null }), []);
  });

  test('downsampling keeps a one-day spike and dip', () => {
    const db = openDb();
    seedTokens(db);
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    for (let i = 0; i < 1000; i++) {
      const usd = i === 401 ? 5000 : i === 702 ? 1 : 100;
      slice(db, 'daily', TODAY - (1000 - i) * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd }]);
    }
    const h = getHistory(db, { kind: 'all' }, 'all', 'none', NOW)!;
    assert.ok(h.points.length <= 400, `got ${h.points.length}`);
    assert.equal(Math.max(...h.points.map((p) => p.total)), 5000);
    assert.equal(Math.min(...h.points.map((p) => p.total)), 1);
    const s = downsampleExtremes(
      Array.from({ length: 5000 }, (_, i) => i),
      Array.from({ length: 5000 }, (_, i) => (i === 1234 ? 9 : 0)),
      400,
    );
    assert.ok(s.size <= 400 && s.has(1234) && s.has(0) && s.has(4999));
  });

  test('scope parsing', () => {
    assert.deepEqual(parseScope('all'), { kind: 'all' });
    assert.deepEqual(parseScope('wallet:3'), { kind: 'wallet', walletId: 3 });
    assert.deepEqual(parseScope(`address:${addr(5).toUpperCase().replace('0X', '0x')}`), { kind: 'address', address: addr(5) });
    assert.equal(parseScope('wallet:x'), null);
    assert.equal(parseScope('address:0x123'), null);
  });
});

describe('address management', () => {
  test('add lowercases, links, enqueues discovery + live once (discovery enqueues backfill); unlink purges orphans', () => {
    const db = openDb();
    const w1 = createWallet(db, { name: 'One' }, NOW);
    const w2 = createWallet(db, { name: 'Two' }, NOW);
    const mixed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
    const r1 = addAddressToWallet(db, w1, { address: mixed, label: 'Safe', chains: ['arbitrum'] }, NOW)!;
    assert.equal(r1.created, true);
    assert.equal(r1.jobIds.length, 2);
    const jobs = db.prepare('SELECT type, payload, status FROM jobs ORDER BY id').all() as { type: string; payload: string; status: string }[];
    assert.deepEqual(
      jobs.map((j) => j.type),
      ['discovery', 'snapshot'],
    );
    assert.deepEqual(JSON.parse(jobs[0].payload).addressIds, [r1.addressId]);
    const stored = db.prepare('SELECT address, chains FROM addresses').get() as { address: string; chains: string };
    assert.equal(stored.address, mixed.toLowerCase());
    assert.equal(stored.chains, '["arbitrum"]');

    const r2 = addAddressToWallet(db, w2, { address: mixed.toLowerCase() }, NOW)!;
    assert.equal(r2.created, false);
    assert.equal(r2.addressId, r1.addressId);
    assert.equal(r2.jobIds.length, 0, 'already scanned address is not re-queued');
    assert.equal(addAddressToWallet(db, 999, { address: mixed }, NOW), null);

    // overview counts it once
    slice(db, 'live', NOW - 60, r1.addressId, 'arbitrum', [{ token: WETH, amount: 1, usd: 42 }]);
    assert.equal(getOverview(db, NOW).totals.netUsd, 42);

    // exclusion through PATCH
    updateAddress(db, r1.addressId, { excluded: true }, NOW);
    assert.equal(getOverview(db, NOW).totals.netUsd, 0);

    assert.deepEqual(removeAddressFromWallet(db, w1, r1.addressId), { purged: false });
    assert.deepEqual(removeAddressFromWallet(db, w2, r1.addressId), { purged: true });
    assert.equal(removeAddressFromWallet(db, w2, r1.addressId), null);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM balances').get() as { n: number }).n, 0);

    const ids = enqueueSync(db, null, NOW);
    assert.equal(ids.length, 1);
    assert.deepEqual(enqueueSync(db, null, NOW), ids, 'pending duplicates are not re-enqueued');
  });
});

describe('pnl invariants', () => {
  const T0 = NOW - 2 * 3600;
  const T1 = NOW - 3600;
  function setup(): { db: QDb; w1: number; w2: number; a: number; b: number } {
    const db = openDb();
    seedTokens(db);
    const w1 = insertWallet(db, 'One', 0, 0);
    const w2 = insertWallet(db, 'Two', 0, 1);
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w1, a);
    link(db, w2, b);
    return { db, w1, w2, a, b };
  }
  const price = (db: QDb, key: string, ts: number, usd: number) => db.prepare("INSERT INTO prices VALUES (?, ?, ?, 'live')").run(key, ts, usd);

  test('internal transfer between two tracked addresses yields pnl 0', () => {
    const { db, a, b } = setup();
    slice(db, 'live', T0, a, 'arbitrum', [{ token: WETH, amount: 10, usd: 20_000 }]);
    slice(db, 'live', T0, b, 'arbitrum', []);
    slice(db, 'live', T1, a, 'arbitrum', []);
    slice(db, 'live', T1, b, 'arbitrum', [{ token: WETH, amount: 10, usd: 20_000 }]);
    const p = getOverview(db, NOW).pnl.all;
    assert.equal(p.startUsd, 20_000);
    assert.equal(p.changeUsd, 0);
    assert.equal(p.pnlUsd, 0);
    assert.equal(p.otherUsd, 0);
  });

  test('a price move on a held token yields amount x delta, also across a transfer; the sender wallet sees the outflow as other', () => {
    const { db, w1, a, b } = setup();
    price(db, 'coingecko:ethereum', T0, 2000);
    price(db, 'coingecko:ethereum', T1, 2200);
    slice(db, 'live', T0, a, 'arbitrum', [{ token: WETH, amount: 10, usd: 20_000 }]);
    slice(db, 'live', T0, b, 'arbitrum', [{ token: NATIVE, amount: 1, usd: 2000 }]);
    slice(db, 'live', T1, a, 'arbitrum', []);
    slice(db, 'live', T1, b, 'arbitrum', [
      { token: NATIVE, amount: 1, usd: 2200 },
      { token: WETH, amount: 10, usd: 22_000 },
    ]);
    const o = getOverview(db, NOW).pnl.all;
    assert.ok(Math.abs(o.pnlUsd! - 11 * 200) < 1e-6, `overview pnl ${o.pnlUsd}`);
    assert.ok(Math.abs(o.otherUsd!) < 1e-6);
    assert.ok(Math.abs(o.returnPct! - 2200 / 22_000) < 1e-9);
    assert.deepEqual(
      o.byAsset.map((x) => [x.asset, Math.round(x.pnlUsd)]),
      [['ETH', 2200]],
    );
    const s = getWalletDetail(db, w1, NOW)!.pnl.all;
    assert.equal(s.changeUsd, -20_000);
    assert.ok(Math.abs(s.pnlUsd! - 2000) < 1e-6, 'priced via the prices table after the token left');
    assert.ok(Math.abs(s.otherUsd! + 22_000) < 1e-6);
  });

  test('debt with a rising price yields negative pnl; deposits do not inflate returnPct', () => {
    const { db, a } = setup();
    slice(db, 'live', T0 - 3600, a, 'arbitrum', [{ token: AWETH, amount: 0.5, usd: 1000, protocol: 'aave-v3', side: 'supply' }]);
    slice(db, 'live', T0, a, 'arbitrum', [
      { token: AWETH, amount: 5, usd: 10_000, protocol: 'aave-v3', side: 'supply' },
      { token: VDUSDC, amount: 1000, usd: -1000, protocol: 'aave-v3', side: 'borrow' },
    ]);
    slice(db, 'live', T1, a, 'arbitrum', [
      { token: AWETH, amount: 5, usd: 10_000, protocol: 'aave-v3', side: 'supply' },
      { token: VDUSDC, amount: 1000, usd: -1100, protocol: 'aave-v3', side: 'borrow' },
    ]);
    const p = getOverview(db, NOW).pnl.all;
    assert.ok(Math.abs(p.pnlUsd! + 100) < 1e-6, `pnl ${p.pnlUsd}`);
    assert.equal(p.startUsd, 1000);
    // capital = 1000 start + 8000 net deposit
    assert.ok(Math.abs(p.returnPct! - -100 / 9000) < 1e-9, `return ${p.returnPct}`);
    assert.equal(getOverview(db, NOW).pnl.all.byAsset[0].asset, 'USD');
  });

  test('no history: nulls; dust start: returnPct null', () => {
    const { db, a } = setup();
    assert.equal(getOverview(db, NOW).pnl['7d'].pnlUsd, null);
    slice(db, 'live', T0, a, 'arbitrum', [{ token: WETH, amount: 0.0000001, usd: 0.0002 }]);
    const p = getOverview(db, NOW).pnl.all;
    assert.equal(p.returnPct, null);
    const w7 = getOverview(db, NOW).pnl['7d'];
    assert.equal(w7.fromTs, T0, 'window starting before the history starts at its first point, like the chart');
    assert.equal(w7.startUsd, 0.0002);
    assert.equal(w7.changeUsd, 0);
  });
});

describe('risk', () => {
  const WETH_ID = 4;
  const USDC_ID = 12;
  function setup(withRates: boolean): QDb {
    const db = openDb();
    seedTokens(db);
    if (withRates) {
      db.exec(`CREATE TABLE aave_reserve_state (snapshot_id INTEGER NOT NULL, chain TEXT NOT NULL, market TEXT NOT NULL, asset TEXT NOT NULL,
        reserve_id INTEGER, supply_apy REAL, borrow_apy REAL, ltv_bps INTEGER, lt_bps INTEGER, emode_category INTEGER, PRIMARY KEY (snapshot_id, market, asset))`);
      for (const c of ['emode INTEGER', 'emode_ltv_bps INTEGER', 'emode_lt_bps INTEGER', 'emode_bitmap TEXT', 'user_config TEXT', 'ltv_bps INTEGER', 'lt_bps INTEGER'])
        db.exec(`ALTER TABLE aave_accounts ADD COLUMN ${c}`);
    }
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    slice(
      db,
      'live',
      NOW - 60,
      a,
      'arbitrum',
      [
        { token: WETH, amount: 1, usd: 2000 },
        { token: AWETH, amount: 10, usd: 20_000, protocol: 'aave-v3', side: 'supply' },
        { token: VDUSDC, amount: 10_000, usd: -10_000, protocol: 'aave-v3', side: 'borrow' },
      ],
      { market: 'arb-core', hf: 1.6, collateral: 20_000, debt: 10_000 },
    );
    if (withRates) {
      const sid = (db.prepare("SELECT id FROM snapshots WHERE kind = 'live'").get() as { id: number }).id;
      const ins = db.prepare('INSERT INTO aave_reserve_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      ins.run(sid, 'arbitrum', 'arb-core', WETH, WETH_ID, 0.02, 0.03, 7500, 8000, 0);
      ins.run(sid, 'arbitrum', 'arb-core', USDC, USDC_ID, 0.04, 0.05, 7500, 7800, 0);
      const cfg = (1n << BigInt(2 * WETH_ID + 1)) | (1n << BigInt(2 * USDC_ID));
      db.prepare('UPDATE aave_accounts SET emode = 0, user_config = ?').run(cfg.toString());
    }
    return db;
  }

  test('without stored rates the rate / liquidation fields are null, exposure still works', () => {
    const o = getOverview(setup(false), NOW);
    assert.equal(o.risk.ltvUsed, null);
    assert.equal(o.risk.netApy, null);
    assert.equal(o.risk.liquidation, null);
    assert.equal(o.aave.positions[0].supplyApy, null);
    assert.deepEqual(o.aave.positions[0].liquidations, []);
    assert.equal(o.risk.leverage, 22_000 / 12_000);
    const eth = o.risk.netExposure.find((e) => e.asset === 'ETH')!;
    assert.equal(eth.amount, 11);
    assert.equal(o.risk.netExposure.find((e) => e.asset === 'USD')!.amount, -10_000);
  });

  test('liquidation price, ltv used and APYs from stored reserve state', () => {
    const o = getOverview(setup(true), NOW);
    const p = o.aave.positions[0];
    assert.ok(Math.abs(p.supplyApy! - 0.02) < 1e-12);
    assert.ok(Math.abs(p.borrowApy! - 0.05) < 1e-12);
    assert.ok(Math.abs(p.netApy! - (400 - 500) / 10_000) < 1e-12);
    assert.ok(Math.abs(p.ltvUsed! - 10_000 / 15_000) < 1e-12);
    const l = o.risk.liquidation!;
    assert.equal(l.asset, 'ETH');
    assert.ok(Math.abs(l.liquidationPrice! - 10_000 / (10 * 0.8)) < 1e-9);
    assert.ok(Math.abs(l.dropPct! - (1 - 1250 / 2000)) < 1e-12);
    assert.ok(Math.abs(o.risk.annualYieldUsd! - -100) < 1e-9);
    assert.equal(o.risk.stableShare, 0);
    assert.deepEqual(o.risk.ath, { usd: 12_000, ts: NOW - 60 });
    assert.equal(o.risk.drawdownPct, 0);
    const usdc = o.topTokens.find((t) => t.key === 'coingecko:usd-coin')!;
    assert.ok(Math.abs(usdc.borrowApy! - 0.05) < 1e-12, 'borrowApy from the stored reserve state');
    assert.equal(usdc.borrowedAmount, 10_000);
    assert.equal(usdc.heldAmount, 0);
    const eth = o.topTokens.find((t) => t.key === 'coingecko:ethereum')!;
    assert.equal(eth.borrowApy, null, 'not borrowed: null even though the reserve has a rate');
    assert.equal(eth.heldAmount, 11);
    assert.equal(eth.borrowedAmount, 0);
  });

  test('topTokens borrowApy is weighted by borrowed usd across markets', () => {
    const db = setup(true);
    const ETH_VD = '0x0000000000000000000000000000000000e0d001';
    db.prepare("INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam) VALUES ('ethereum', ?, 'variableDebtEthUSDC', NULL, 6, 'vdebt', ?, 'eth-core', NULL, NULL, 0)").run(ETH_VD, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    db.prepare("INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam) VALUES ('ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC', 'USD Coin', 6, 'erc20', NULL, NULL, 'coingecko:usd-coin', NULL, 0)").run();
    slice(db, 'live', NOW - 60, 1, 'ethereum', [{ token: ETH_VD, amount: 30_000, usd: -30_000, protocol: 'aave-v3', side: 'borrow' }]);
    const sid = (db.prepare("SELECT id FROM snapshots WHERE kind = 'live'").get() as { id: number }).id;
    db.prepare('INSERT INTO aave_reserve_state VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(sid, 'ethereum', 'eth-core', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 3, 0.03, 0.09, 7500, 7800, 0);
    const usdc = getOverview(db, NOW).topTokens.find((t) => t.key === 'coingecko:usd-coin')!;
    assert.equal(usdc.borrowedAmount, 40_000);
    assert.ok(Math.abs(usdc.borrowApy! - (10_000 * 0.05 + 30_000 * 0.09) / 40_000) < 1e-12, `apy ${usdc.borrowApy}`);
  });
});

describe('stacked by wallet', () => {
  test('a shared address goes to the lowest wallet id, layers add up to the total, wallet colors kept', () => {
    const db = openDb();
    seedTokens(db);
    const w1 = Number(db.prepare("INSERT INTO wallets (name, color, sort) VALUES ('Old', '#111111', 5)").run().lastInsertRowid);
    const w2 = Number(db.prepare("INSERT INTO wallets (name, color, sort) VALUES ('New', NULL, 0)").run().lastInsertRowid);
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w2, a); // linked to the newer wallet first ...
    link(db, w1, a); // ... and later to the older one
    link(db, w2, b);
    slice(db, 'live', NOW - 600, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 10 }]);
    slice(db, 'live', NOW - 600, b, 'arbitrum', [{ token: WETH, amount: 1, usd: 5 }]);
    const h = getHistory(db, { kind: 'all' }, '24h', 'wallet', NOW)!;
    const last = h.points[h.points.length - 1];
    assert.equal(last.total, 15);
    assert.deepEqual(last.series, { [String(w1)]: 10, [String(w2)]: 5 });
    const colors = Object.fromEntries(h.keys.map((k) => [k.key, k.color]));
    assert.equal(colors[String(w1)], '#111111');
    assert.ok(colors[String(w2)], 'wallet without a color gets a palette color');
  });
});

describe('history assets and debt', () => {
  // a: Aave position on arbitrum (borrow on days 5..3, closed on day 2); b: ethereum wallet, days 5 and 4 only
  function setup(): { db: QDb; w1: number; w2: number; a: number; b: number } {
    const db = openDb();
    seedTokens(db);
    const w1 = insertWallet(db, 'Safe', 0, 0);
    const w2 = insertWallet(db, 'Eoa', 0, 1);
    const a = insertAddress(db, 1);
    const b = insertAddress(db, 2);
    link(db, w1, a);
    link(db, w2, b);
    for (const i of [5, 4, 3]) {
      slice(db, 'daily', TODAY - i * DAY, a, 'arbitrum', [
        { token: WETH, amount: 1, usd: 10 },
        { token: AWETH, amount: 10, usd: 1000 + i, protocol: 'aave-v3', side: 'supply' },
        { token: VDUSDC, amount: 400 + i, usd: -(400 + i), protocol: 'aave-v3', side: 'borrow' },
      ]);
    }
    slice(db, 'daily', TODAY - 2 * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 10 }]);
    slice(db, 'daily', TODAY - 1 * DAY, a, 'arbitrum', [{ token: WETH, amount: 1, usd: 11 }]);
    slice(db, 'daily', TODAY - 5 * DAY, b, 'ethereum', [{ token: NATIVE, amount: 1, usd: 50 }]);
    slice(db, 'daily', TODAY - 4 * DAY, b, 'ethereum', [{ token: NATIVE, amount: 1, usd: 60 }]);
    // today: the position is reopened intraday
    slice(db, 'live', NOW - 600, a, 'arbitrum', [
      { token: AWETH, amount: 10, usd: 2000, protocol: 'aave-v3', side: 'supply' },
      { token: VDUSDC, amount: 700, usd: -700, protocol: 'aave-v3', side: 'borrow' },
    ]);
    return { db, w1, w2, a, b };
  }

  test('debt carried forward per slice, drops to 0 when the position closes, total = assets - debt', () => {
    const { db } = setup();
    const h = getHistory(db, { kind: 'all' }, '7d', 'none', NOW)!;
    assertAssetsDebt(h.points);
    const at = (t: number) => h.points.find((p) => p.t === t)!;
    assert.equal(at(TODAY - 5 * DAY).debtUsd, 405);
    assert.equal(at(TODAY - 5 * DAY).assetsUsd, 10 + 1005 + 50);
    assert.equal(at(TODAY - 4 * DAY).debtUsd, 404);
    assert.equal(at(TODAY - 3 * DAY).debtUsd, 403);
    assert.equal(at(TODAY - 3 * DAY).assetsUsd, 10 + 1003 + 60, 'b carried forward in assets');
    assert.equal(at(TODAY - 2 * DAY).debtUsd, 0, 'closed position has no stale debt');
    assert.equal(at(TODAY - 2 * DAY).assetsUsd, 70);
    const last = h.points[h.points.length - 1];
    assert.equal(last.debtUsd, 700);
    assert.equal(last.assetsUsd, 2060);
    assert.equal(last.total, 1360);
  });

  test('a seed point at the range start carries the debt of that time', () => {
    const { db } = setup();
    // 4 days ago + 1h: the latest display state is day 4 for both slices
    const h = getHistory(db, { kind: 'all' }, '24h', 'none', TODAY - 3 * DAY + 3600)!;
    assertAssetsDebt(h.points);
    assert.equal(h.points[0].t, TODAY - 4 * DAY + 3600);
    assert.equal(h.points[0].debtUsd, 404);
    assert.equal(h.points[0].assetsUsd, 10 + 1004 + 60);
  });

  test('every range and groupBy carries the same assets / debt as groupBy none', () => {
    const { db, w1 } = setup();
    const ranges: HistoryRange[] = ['24h', '7d', '30d', '90d', '1y', 'all'];
    for (const scope of [{ kind: 'all' as const }, { kind: 'wallet' as const, walletId: w1 }]) {
      for (const r of ranges) {
        const base = getHistory(db, scope, r, 'none', NOW)!;
        assertAssetsDebt(base.points);
        assert.ok(base.points.length > 0, `${r} has points`);
        for (const g of ['chain', 'wallet', 'protocol'] as const) {
          const h = getHistory(db, scope, r, g, NOW)!;
          assertAssetsDebt(h.points);
          assert.deepEqual(
            h.points.map((p) => [p.t, p.total, p.assetsUsd, p.debtUsd]),
            base.points.map((p) => [p.t, p.total, p.assetsUsd, p.debtUsd]),
            `${scope.kind} ${r} ${g}`,
          );
        }
      }
    }
  });

  test('pnl windows match the range pills: same start time and end value as the chart', () => {
    const { db, w1 } = setup();
    for (const [scope, view] of [
      [{ kind: 'all' as const }, getOverview(db, NOW)],
      [{ kind: 'wallet' as const, walletId: w1 }, getWalletDetail(db, w1, NOW)!],
    ] as const) {
      assert.deepEqual(Object.keys(view.pnl).sort(), ['1y', '24h', '30d', '7d', '90d', 'all'].sort());
      for (const r of ['24h', '7d', '30d', '90d', '1y', 'all'] as HistoryRange[]) {
        const h = getHistory(db, scope, r, 'none', NOW)!;
        const p = view.pnl[r];
        assert.equal(p.fromTs, h.points[0].t, `${scope.kind} ${r} fromTs`);
        assert.ok(Math.abs(p.startUsd! - h.points[0].total) < 1e-9, `${scope.kind} ${r} startUsd`);
        assert.ok(Math.abs(p.endUsd - h.points[h.points.length - 1].total) < 1e-9, `${scope.kind} ${r} endUsd`);
      }
    }
  });
});

describe('FRONTEND: Curve loans next to Aave', () => {
  test('curve-crvusd rows are not Aave markets, but count in totals, byProtocol and the address protocols', () => {
    const db = openDb();
    seedTokens(db);
    const AMM = '0x5a5a00000000000000000000000000000000ca01';
    const CONTROLLER = '0x5a5a00000000000000000000000000000000ca02';
    const WETH_L1 = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const ins = db.prepare('INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, logo, spam) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)');
    ins.run('ethereum', AMM, 'WETH', 'WETH', 18, 'curve-collateral', WETH_L1, 'eth-crvusd-3-weth', 'coingecko:ethereum');
    ins.run('ethereum', CONTROLLER, 'crvUSD', 'crvUSD', 18, 'curve-debt', '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e', 'eth-crvusd-3-weth', 'coingecko:crvusd');
    const w = insertWallet(db, 'W');
    const a = insertAddress(db, 1);
    link(db, w, a);
    slice(db, 'live', NOW - 300, a, 'arbitrum', [
      { token: AWETH, amount: 4, usd: 10000, protocol: 'aave-v3', side: 'supply' },
      { token: VDUSDC, amount: 2000, usd: -2000, protocol: 'aave-v3', side: 'borrow' },
    ], { market: 'arb-core', hf: 4, collateral: 10000, debt: 2000 });
    slice(db, 'live', NOW - 300, a, 'ethereum', [
      { token: AMM, amount: 2, usd: 5000, protocol: 'curve-crvusd', side: 'supply' },
      { token: CONTROLLER, amount: 3000, usd: -3000, protocol: 'curve-crvusd', side: 'borrow' },
    ]);
    const o = getOverview(db, NOW);
    assert.deepEqual(o.aave.positions.map((p) => p.market), ['arb-core']);
    assert.equal(o.aave.borrowedUsd, 2000);
    assert.equal(o.totals.netUsd, 10000);
    const proto = Object.fromEntries(o.byProtocol.map((p) => [p.key, p.usd]));
    assert.equal(proto['curve-crvusd'], 2000);
    assert.equal(o.byProtocol.find((p) => p.key === 'curve-crvusd')?.label, 'Curve crvUSD');
    // no curve_positions table in this schema: the detail list is empty, not an error
    assert.deepEqual(o.curve, []);
    const d = getAddressDetail(db, addr(1), NOW)!;
    const curve = d.protocols.find((p) => p.market === 'eth-crvusd-3-weth');
    assert.equal(curve?.protocol, 'curve-crvusd');
    assert.equal(curve?.borrowedUsd, 3000);
    assert.equal(d.protocols.find((p) => p.market === 'arb-core')?.protocol, 'aave-v3');
  });
});
