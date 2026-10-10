// Unleveraged line, Aave interest (ledger / index / estimate) and the display currency PnL split,
// against temp SQLite databases (node:sqlite, no network). Synthetic addresses only.
// Run: NODE_OPTIONS=--experimental-sqlite tsx --test lib/queries/__tests__/yield.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../db/migrate';
import type { QDb } from '../db';
import { getFx, loadFx } from '../fx';
import { getHistory } from '../history';
import { loadScopeHistory, pnlPeriod, type WindowYield } from '../pnl';
import { loadTokens } from '../state';
import { getYield, loadScopeYield, windowYield } from '../yield';

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 5) / 1000; // a Monday, 00:00 UTC
const NOW = T0 + 10 * DAY;

const SCHEMA = `
CREATE TABLE wallets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE addresses (id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE, label TEXT, chains TEXT, is_contract TEXT, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE wallet_addresses (wallet_id INTEGER NOT NULL, address_id INTEGER NOT NULL, PRIMARY KEY (wallet_id, address_id));
CREATE TABLE tokens (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT, name TEXT, decimals INTEGER, kind TEXT, underlying TEXT, market TEXT, price_key TEXT, logo TEXT, spam INTEGER DEFAULT 0, PRIMARY KEY (chain, address));
CREATE TABLE prices (price_key TEXT NOT NULL, ts INTEGER NOT NULL, usd REAL NOT NULL, granularity TEXT NOT NULL, PRIMARY KEY (price_key, granularity, ts));
CREATE TABLE fx (day TEXT NOT NULL, currency TEXT NOT NULL, rate_from_usd REAL NOT NULL, PRIMARY KEY (day, currency));
CREATE TABLE snapshots (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL);
CREATE TABLE balances (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, protocol TEXT, side TEXT);
CREATE TABLE position_values (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, chain TEXT NOT NULL, protocol TEXT NOT NULL, usd REAL NOT NULL);
CREATE TABLE aave_accounts (snapshot_id INTEGER NOT NULL, address_id INTEGER NOT NULL, market TEXT NOT NULL, collateral_usd REAL, debt_usd REAL, health_factor REAL);
CREATE TABLE aave_rates (chain TEXT NOT NULL, market TEXT NOT NULL, asset TEXT NOT NULL, ts INTEGER NOT NULL, block INTEGER, supply_apy REAL, borrow_apy REAL, liquidity_index REAL, borrow_index REAL, PRIMARY KEY (market, asset, ts));
CREATE TABLE tx (chain TEXT NOT NULL, hash TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL, from_addr TEXT, receipt INTEGER DEFAULT 0, fee_wei TEXT, fee_usd REAL, PRIMARY KEY (chain, hash));
CREATE TABLE tx_transfers (chain TEXT NOT NULL, hash TEXT NOT NULL, ref TEXT NOT NULL, token TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, kind_hint TEXT NOT NULL, PRIMARY KEY (chain, hash, ref));
CREATE TABLE tx_addresses (address_id INTEGER NOT NULL, chain TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (address_id, chain, hash));
CREATE TABLE ledger_state (address_id INTEGER NOT NULL, chain TEXT NOT NULL, last_block INTEGER, native_block INTEGER, updated_at INTEGER, error TEXT, PRIMARY KEY (address_id, chain));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

// public Arbitrum token / Aave contracts; tracked addresses are synthetic
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const AWETH = '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8';
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const AUSDC = '0x724dc807b04555b71ed48a6896b6f41593b8c637';
const VDUSDC = '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6';
const ZERO = '0x0000000000000000000000000000000000000000';
const ME = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0001';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'yq-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(schema = SCHEMA): QDb {
  const d = new DatabaseSync(join(dir, `t${Math.random().toString(36).slice(2)}.db`));
  if (schema) d.exec(schema);
  return d as unknown as QDb;
}

function seed(db: QDb): number {
  db.prepare("INSERT INTO wallets (id, name) VALUES (1, 'w')").run();
  db.prepare(`INSERT INTO addresses (id, address, chains, excluded) VALUES (1, ?, '["arbitrum"]', 0)`).run(ME);
  db.prepare('INSERT INTO wallet_addresses VALUES (1, 1)').run();
  const ins = db.prepare('INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key, spam) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)');
  ins.run('arbitrum', WETH, 'WETH', 'Wrapped Ether', 18, 'erc20', null, null, 'coingecko:ethereum');
  ins.run('arbitrum', USDC, 'USDC', 'USD Coin', 6, 'erc20', null, null, 'coingecko:usd-coin');
  ins.run('arbitrum', AWETH, 'aArbWETH', 'Aave WETH', 18, 'atoken', WETH, 'arb-core', null);
  ins.run('arbitrum', AUSDC, 'aArbUSDCn', 'Aave USDC', 6, 'atoken', USDC, 'arb-core', null);
  ins.run('arbitrum', VDUSDC, 'variableDebtArbUSDCn', 'Aave USDC debt', 6, 'vdebt', USDC, 'arb-core', null);
  return 1;
}

type Bal = { token: string; amount: number; price: number; side?: 'wallet' | 'supply' | 'borrow' };

/** One live snapshot of the address on arbitrum (balances valued at `price`, debt negative). */
function snap(db: QDb, ts: number, bals: Bal[], kind: 'live' | 'daily' = 'live'): void {
  const sid = Number(db.prepare('INSERT INTO snapshots (ts, kind) VALUES (?, ?)').run(ts, kind).lastInsertRowid);
  const byProto = new Map<string, number>([['wallet', 0]]);
  for (const b of bals) {
    const side = b.side ?? 'wallet';
    const protocol = side === 'wallet' ? 'wallet' : 'aave-v3';
    const usd = (side === 'borrow' ? -1 : 1) * b.amount * b.price;
    db.prepare('INSERT INTO balances VALUES (?, 1, ?, ?, NULL, ?, ?, ?, ?)').run(sid, 'arbitrum', b.token, b.amount, usd, protocol, side);
    byProto.set(protocol, (byProto.get(protocol) ?? 0) + usd);
  }
  for (const [p, usd] of byProto) db.prepare('INSERT INTO position_values VALUES (?, 1, ?, ?, ?)').run(sid, 'arbitrum', p, usd);
}

describe('unleveraged line', () => {
  test('equals net worth on every point without debt (price moves and a deposit)', () => {
    const db = openDb();
    seed(db);
    snap(db, T0, [{ token: WETH, amount: 1, price: 1000 }]);
    snap(db, T0 + DAY, [{ token: WETH, amount: 1, price: 1100 }]);
    snap(db, T0 + 2 * DAY, [{ token: WETH, amount: 3, price: 1050 }]); // +2 WETH deposited
    snap(db, T0 + 3 * DAY, [{ token: WETH, amount: 3, price: 900 }, { token: USDC, amount: 500, price: 1 }]);
    snap(db, T0 + 4 * DAY, [{ token: USDC, amount: 3200, price: 1 }]);
    const h = getHistory(db, { kind: 'address', address: ME }, 'all', 'none', NOW)!;
    assert.equal(h.points.length, 5);
    for (const p of h.points) assert.ok(Math.abs((p.unleveredUsd ?? NaN) - p.total) < 1e-9, `U != total at ${p.t}: ${p.unleveredUsd} vs ${p.total}`);
  });

  function levered(prices: number[]): { total: number[]; u: number[] } {
    const db = openDb();
    seed(db);
    // 2 WETH supplied, 1000 USDC borrowed: 2x leverage at 1000
    prices.forEach((p, i) =>
      snap(db, T0 + i * DAY, [
        { token: AWETH, amount: 2, price: p, side: 'supply' },
        { token: VDUSDC, amount: 1000, price: 1, side: 'borrow' },
      ]),
    );
    const h = getHistory(db, { kind: 'address', address: ME }, 'all', 'none', NOW)!;
    return { total: h.points.map((p) => p.total), u: h.points.map((p) => p.unleveredUsd!) };
  }

  test('rising prices with leverage: net worth rises more than the unleveraged line', () => {
    const r = levered([1000, 1100, 1210]);
    assert.ok(Math.abs(r.u[0] - 1000) < 1e-9);
    // asset return 10% per step on the starting 1000 of equity
    assert.ok(Math.abs(r.u[1] - 1100) < 1e-9);
    assert.ok(Math.abs(r.u[2] - 1210) < 1e-9);
    assert.ok(Math.abs(r.total[2] - 1420) < 1e-9);
    assert.ok(r.total[2] > r.u[2]);
  });

  test('falling prices with leverage: net worth falls more than the unleveraged line', () => {
    const r = levered([1000, 900, 810]);
    assert.ok(Math.abs(r.u[2] - 810) < 1e-9);
    assert.ok(Math.abs(r.total[2] - 620) < 1e-9);
    assert.ok(r.total[2] < r.u[2]);
  });
});

describe('interest', () => {
  /** aUSDC supply growing by interest, with a 500 USDC supply on day 1.5 (its aToken mint includes accrued interest). */
  function supplyCase(withLedger: boolean, withIndex: boolean): QDb {
    const db = openDb();
    seed(db);
    snap(db, T0, [{ token: AUSDC, amount: 1000, price: 1, side: 'supply' }], 'daily');
    snap(db, T0 + DAY, [{ token: AUSDC, amount: 1000.1, price: 1, side: 'supply' }], 'daily');
    snap(db, T0 + 2 * DAY, [{ token: AUSDC, amount: 1500.25, price: 1, side: 'supply' }], 'daily');
    if (withLedger) {
      const ts = T0 + 2 * DAY + DAY / 2; // inside the day of the third daily (effective at T0 + 3 days)
      db.prepare("INSERT INTO tx VALUES ('arbitrum', '0xa1', 100, ?, ?, 1, NULL, 0.05)").run(ts, ME);
      db.prepare("INSERT INTO tx_addresses VALUES (1, 'arbitrum', '0xa1', ?)").run(ts);
      const leg = db.prepare("INSERT INTO tx_transfers VALUES ('arbitrum', '0xa1', ?, ?, ?, ?, NULL, ?, NULL, 'erc20')");
      leg.run('log:1', USDC, ME, AUSDC, 500); // underlying into the reserve: the principal
      leg.run('log:2', AUSDC, ZERO, ME, 500.07); // mint = amount + accrued interest: NOT principal
      db.prepare("INSERT INTO ledger_state VALUES (1, 'arbitrum', 100, 100, ?, NULL)").run(NOW);
    }
    if (withIndex) {
      const ins = db.prepare("INSERT INTO aave_rates VALUES ('arbitrum', 'arb-core', ?, ?, 1, 0.04, 0.05, ?, 1.0)");
      ins.run(USDC, T0 + DAY, 1.0);
      ins.run(USDC, T0 + 2 * DAY, 1.0001);
      ins.run(USDC, T0 + 3 * DAY, 1.0002);
    }
    return db;
  }

  test('ledger: balance change minus the underlying supplied, mint amount ignored', () => {
    const db = supplyCase(true, false);
    const y = getYield(db, { kind: 'address', address: ME }, 'all', NOW)!;
    assert.equal(y.method, 'ledger');
    assert.equal(y.estimated, false);
    assert.ok(Math.abs(y.earnedUsd - 0.25) < 1e-9, `earned ${y.earnedUsd}`);
    assert.equal(y.paidUsd, 0);
    assert.ok(Math.abs(y.gasUsd - 0.05) < 1e-12);
    assert.ok(Math.abs(y.netUsd - 0.2) < 1e-9);
    assert.equal(y.bucket, 'week'); // range 'all'
    assert.equal(y.buckets.length, 1);
    assert.ok(Math.abs(y.buckets[y.buckets.length - 1].cumulativeUsd - 0.2) < 1e-9);
  });

  test('index: balance x index growth when the ledger is not ingested', () => {
    const db = supplyCase(false, true);
    const y = getYield(db, { kind: 'address', address: ME }, 'all', NOW)!;
    assert.equal(y.method, 'index');
    assert.equal(y.estimated, false);
    // 1000 x 1e-4 + 1000.1 x (1.0002 / 1.0001 - 1)
    const expected = 1000 * 1e-4 + 1000.1 * (1.0002 / 1.0001 - 1);
    assert.ok(Math.abs(y.earnedUsd - expected) < 1e-9, `earned ${y.earnedUsd} vs ${expected}`);
    assert.equal(y.gasKnown, false);
  });

  test('estimate: APY x balance x time without ledger or index, marked estimated', () => {
    const db = supplyCase(false, false);
    db.prepare("INSERT INTO aave_rates (chain, market, asset, ts, supply_apy, borrow_apy) VALUES ('arbitrum', 'arb-core', ?, ?, 0.0365, 0.05)").run(USDC, T0);
    const y = getYield(db, { kind: 'address', address: ME }, 'all', NOW)!;
    assert.equal(y.method, 'estimate');
    assert.equal(y.estimated, true);
    const g = Math.pow(1.0365, 1 / 365) - 1;
    assert.ok(Math.abs(y.earnedUsd - (1000 + 1000.1) * g) < 1e-9);
  });

  test('borrow interest: debt growth minus the borrowed principal, counted as paid', () => {
    const db = openDb();
    seed(db);
    snap(db, T0, [{ token: AWETH, amount: 1, price: 2000, side: 'supply' }, { token: VDUSDC, amount: 500, price: 1, side: 'borrow' }], 'daily');
    snap(db, T0 + DAY, [{ token: AWETH, amount: 1, price: 2000, side: 'supply' }, { token: VDUSDC, amount: 800.2, price: 1, side: 'borrow' }], 'daily');
    const ts = T0 + DAY + 3600;
    db.prepare("INSERT INTO tx VALUES ('arbitrum', '0xb1', 100, ?, NULL, 1, NULL, NULL)").run(ts);
    db.prepare("INSERT INTO tx_addresses VALUES (1, 'arbitrum', '0xb1', ?)").run(ts);
    const leg = db.prepare("INSERT INTO tx_transfers VALUES ('arbitrum', '0xb1', ?, ?, ?, ?, NULL, ?, NULL, 'erc20')");
    leg.run('log:1', VDUSDC, ZERO, ME, 300.15); // debt mint incl. accrued interest
    leg.run('log:2', USDC, AUSDC, ME, 300); // borrowed underlying leaves the reserve
    db.prepare("INSERT INTO ledger_state VALUES (1, 'arbitrum', 100, 100, ?, NULL)").run(NOW);
    const tokens = loadTokens(db);
    const h = loadScopeHistory(db, [1], tokens);
    const w = windowYield(loadScopeYield(db, [1], h, tokens), 0, NOW);
    assert.ok(Math.abs(w.paidUsd - 0.2) < 1e-9, `paid ${w.paidUsd}`);
    assert.ok(Math.abs(w.interestUsd + 0.2) < 1e-9);
  });

  test('PnlPeriod: otherUsd excludes interest and gas', () => {
    const db = supplyCase(true, false);
    const tokens = loadTokens(db);
    const h = loadScopeHistory(db, [1], tokens);
    const y = loadScopeYield(db, [1], h, tokens);
    const p = pnlPeriod(h, 'all', h.earliest!, Infinity, { yieldIn: (f, t) => windowYield(y, f, t) });
    assert.ok(Math.abs(p.interestUsd! - 0.25) < 1e-9);
    assert.ok(Math.abs(p.gasUsd! - 0.05) < 1e-12);
    // change 500.25 = price 0 + interest 0.25 - gas 0.05 + other 500.05
    assert.ok(Math.abs(p.otherUsd! - 500.05) < 1e-9, `other ${p.otherUsd}`);
  });
});

describe('display currency PnL', () => {
  function fxCase(): QDb {
    const db = openDb();
    seed(db);
    snap(db, T0, [{ token: WETH, amount: 1, price: 1000 }, { token: USDC, amount: 1000, price: 1 }]);
    snap(db, T0 + DAY, [{ token: WETH, amount: 1, price: 1200 }, { token: USDC, amount: 1000, price: 1 }]);
    snap(db, T0 + 2 * DAY, [{ token: WETH, amount: 2, price: 1100 }, { token: USDC, amount: 1000, price: 1 }]); // +1 WETH deposited
    snap(db, T0 + 3 * DAY, [{ token: WETH, amount: 2, price: 1300 }, { token: USDC, amount: 400, price: 1 }]); // 600 USDC withdrawn
    const ins = db.prepare('INSERT INTO fx VALUES (?, ?, ?)');
    const day = (i: number) => new Date((T0 + i * DAY) * 1000).toISOString().slice(0, 10);
    [0.9, 0.85, 0.88, 0.8].forEach((r, i) => ins.run(day(i), 'CHF', r));
    [0.95, 0.96, 0.94, 0.93].forEach((r, i) => ins.run(day(i), 'EUR', r));
    return db;
  }

  test('market + fx effect + other sums exactly to the change in the currency', () => {
    const db = fxCase();
    const tokens = loadTokens(db);
    const h = loadScopeHistory(db, [1], tokens);
    const fx = loadFx(db);
    const p = pnlPeriod(h, 'all', h.earliest!, Infinity, { fx });
    for (const c of ['CHF', 'EUR'] as const) {
      const cp = p.currencies![c]!;
      assert.ok(cp, `${c} missing`);
      assert.ok(Math.abs(cp.start - p.startUsd! * fx.rateAt(c, T0)!) < 1e-9);
      assert.ok(Math.abs(cp.end - p.endUsd * fx.rateAt(c, T0 + 3 * DAY)!) < 1e-9);
      assert.ok(Math.abs(cp.market + cp.fxEffect + cp.other - cp.change) < 1e-9, `${c} does not sum`);
      assert.equal(cp.interest, null);
    }
    const chf = p.currencies!.CHF!;
    // price pnl per step (USD): +200, -100, +400, converted at that step's rate
    assert.ok(Math.abs(chf.market - (200 * 0.85 - 100 * 0.88 + 400 * 0.8)) < 1e-9);
    // net worth held x rate change: 2000 x -0.05, 2200 x +0.03, 3200 x -0.08
    assert.ok(Math.abs(chf.fxEffect - (2000 * -0.05 + 2200 * 0.03 + 3200 * -0.08)) < 1e-9);
    // flows (+1100 deposit, -600 withdrawal) at their day's rate
    assert.ok(Math.abs(chf.other - (1100 * 0.88 - 600 * 0.8)) < 1e-9);
  });

  test('interest and gas are split out per day and the identity still holds', () => {
    const db = fxCase();
    const tokens = loadTokens(db);
    const h = loadScopeHistory(db, [1], tokens);
    const y: WindowYield = { interestUsd: 3, gasUsd: 1, estimated: false, daily: [{ t: T0 + DAY, interestUsd: 3, gasUsd: 1 }] };
    const p = pnlPeriod(h, 'all', h.earliest!, Infinity, { fx: loadFx(db), yieldIn: () => y });
    const cp = p.currencies!.CHF!;
    assert.ok(Math.abs(cp.interest! - 3 * 0.85) < 1e-12);
    assert.ok(Math.abs(cp.gas! - 0.85) < 1e-12);
    assert.ok(Math.abs(cp.market + cp.fxEffect + cp.interest! - cp.gas! + cp.other - cp.change) < 1e-9);
  });

  test('weekends and later days use the last published rate', () => {
    const db = fxCase();
    const fx = loadFx(db);
    assert.equal(fx.rateAt('CHF', T0 + 9 * DAY), 0.8);
    assert.equal(fx.rateAt('CHF', T0 - 5 * DAY), 0.9);
    const r = getFx(db);
    assert.equal(r.latest?.CHF, 0.8);
    assert.equal(r.latest?.EUR, 0.93);
    assert.equal(r.latest?.usdChf, 0.8);
    assert.equal(Object.keys(r.daily).length, 4);
    assert.equal(r.rates?.EUR[new Date(T0 * 1000).toISOString().slice(0, 10)], 0.95);
  });
});

describe('migration 7', () => {
  test('moves the USD -> CHF table into the per currency fx table', () => {
    const db = openDb('');
    migrate(db);
    // simulate a database from before migration 7
    db.exec('DROP TABLE fx');
    db.exec('CREATE TABLE fx (day TEXT PRIMARY KEY, usd_chf REAL NOT NULL)');
    db.exec("INSERT INTO fx VALUES ('2026-01-05', 0.9), ('2026-01-06', 0.91)");
    db.exec('DROP TABLE aave_rates');
    db.exec('PRAGMA user_version = 6');
    migrate(db);
    const rows = (db.prepare('SELECT day, currency, rate_from_usd AS r FROM fx ORDER BY day').all() as { day: string; currency: string; r: number }[]).map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { day: '2026-01-05', currency: 'CHF', r: 0.9 },
      { day: '2026-01-06', currency: 'CHF', r: 0.91 },
    ]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'aave_rates'").get());
  });
});
