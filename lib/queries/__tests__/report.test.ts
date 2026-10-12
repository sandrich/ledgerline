// Bot report (lib/queries/report.ts) and the bot token check, against a temp SQLite database
// (node:sqlite, full migrated schema, no network). Synthetic addresses only.
// Run: NODE_OPTIONS=--experimental-sqlite tsx --test lib/queries/__tests__/report.test.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { requireBotToken } from '../../../app/api/_lib/bot-auth';
import { migrate } from '../../db/migrate';
import type { TopToken } from '../api-types';
import type { QDb } from '../db';
import { getReport, holdingChanges } from '../report';

const DAY = 86_400;
const NOW = Date.UTC(2026, 9, 9, 12) / 1000;
const ME = '0x1111111111111111111111111111111111111111';
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const AWETH = '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8';
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const VDUSDC = '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'report-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function openDb(): QDb {
  const d = new DatabaseSync(join(dir, `r${Math.random().toString(36).slice(2)}.db`));
  migrate(d as never);
  return d as unknown as QDb;
}

type Bal = { token: string; amount: number; usd: number; protocol?: string; side?: 'wallet' | 'supply' | 'borrow' };

function slice(db: QDb, ts: number, addressId: number, bals: Bal[], aave?: { hf: number; collateral: number; debt: number }): void {
  const sid = Number(db.prepare("INSERT INTO snapshots (ts, kind) VALUES (?, 'live')").run(ts).lastInsertRowid);
  const byProto = new Map<string, number>();
  for (const b of bals) {
    const protocol = b.protocol ?? 'wallet';
    db.prepare('INSERT INTO balances (snapshot_id, address_id, chain, token, amount_raw, amount, usd, protocol, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      sid,
      addressId,
      'arbitrum',
      b.token,
      String(Math.round(b.amount * 1e6)),
      b.amount,
      b.usd,
      protocol,
      b.side ?? 'wallet',
    );
    byProto.set(protocol, (byProto.get(protocol) ?? 0) + b.usd);
  }
  for (const [p, usd] of byProto) {
    db.prepare('INSERT INTO position_values (snapshot_id, address_id, chain, protocol, usd) VALUES (?, ?, ?, ?, ?)').run(sid, addressId, 'arbitrum', p, usd);
  }
  if (aave) {
    db.prepare('INSERT INTO aave_accounts (snapshot_id, address_id, market, collateral_usd, debt_usd, health_factor) VALUES (?, ?, ?, ?, ?, ?)').run(
      sid,
      addressId,
      'arb-core',
      aave.collateral,
      aave.debt,
      aave.hf,
    );
  }
}

function seed(db: QDb): number {
  const ins = db.prepare('INSERT INTO tokens (chain, address, symbol, name, decimals, kind, underlying, market, price_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('arbitrum', WETH, 'WETH', 'Wrapped Ether', 18, 'erc20', null, null, 'coingecko:ethereum');
  ins.run('arbitrum', USDC, 'USDC', 'USD Coin', 6, 'erc20', null, null, 'coingecko:usd-coin');
  ins.run('arbitrum', AWETH, 'aArbWETH', 'Aave Arbitrum WETH', 18, 'atoken', WETH, 'arb-core', null);
  ins.run('arbitrum', VDUSDC, 'variableDebtArbUSDCn', 'Aave Arbitrum Variable Debt USDCn', 6, 'vdebt', USDC, 'arb-core', null);
  db.prepare("INSERT INTO prices (price_key, ts, usd, granularity) VALUES ('coingecko:ethereum', ?, 2200, 'live')").run(NOW - 300);
  db.prepare("INSERT INTO prices (price_key, ts, usd, granularity) VALUES ('coingecko:usd-coin', ?, 1, 'live')").run(NOW - 300);
  const w = Number(db.prepare("INSERT INTO wallets (name, created_at) VALUES ('Main', 0)").run().lastInsertRowid);
  const a = Number(db.prepare(`INSERT INTO addresses (address, label, chains, created_at) VALUES (?, 'main', '["arbitrum"]', 0)`).run(ME).lastInsertRowid);
  db.prepare('INSERT INTO wallet_addresses (wallet_id, address_id) VALUES (?, ?)').run(w, a);
  return a;
}

describe('bot report', () => {
  test('holdings, PnL and health factor change over 24h', () => {
    const db = openDb();
    const a = seed(db);
    // yesterday: 1 WETH in the wallet, 2 WETH supplied, 1'000 USDC borrowed at ETH 2'000
    slice(
      db,
      NOW - DAY - 3600,
      a,
      [
        { token: WETH, amount: 1, usd: 2000 },
        { token: AWETH, amount: 2, usd: 4000, protocol: 'aave-v3', side: 'supply' },
        { token: VDUSDC, amount: 1000, usd: -1000, protocol: 'aave-v3', side: 'borrow' },
      ],
      { hf: 3.2, collateral: 4000, debt: 1000 },
    );
    // now: ETH at 2'200, 0.5 WETH more in the wallet, borrowed 2'000 more
    slice(
      db,
      NOW - 300,
      a,
      [
        { token: WETH, amount: 1.5, usd: 3300 },
        { token: AWETH, amount: 2, usd: 4400, protocol: 'aave-v3', side: 'supply' },
        { token: VDUSDC, amount: 3000, usd: -3000, protocol: 'aave-v3', side: 'borrow' },
      ],
      { hf: 1.24, collateral: 4400, debt: 3000 },
    );

    const r = getReport(db, { addressIds: [a], scope: 'all', window: '24h', currency: 'USD' }, NOW);
    assert.equal(r.from, NOW - DAY);
    assert.equal(r.netWorth.startUsd, 5000);
    assert.equal(r.netWorth.endUsd, 4700);
    assert.equal(r.netWorth.changeUsd, -300);
    assert.equal(r.netWorth.debtUsd, 3000);
    assert.equal(r.freshness.stale, false);
    // price PnL on what was held: 3 ETH x +200 = +600 (the USDC debt did not move)
    assert.ok(Math.abs((r.pnl.pnlUsd ?? 0) - 600) < 1e-6, `pnl ${r.pnl.pnlUsd}`);
    assert.equal(r.currency.code, 'USD');
    assert.equal(r.currency.change, -300);

    const eth = r.holdings.find((h) => h.key === 'coingecko:ethereum')!;
    assert.equal(eth.status, 'changed');
    assert.equal(eth.heldStart, 3);
    assert.equal(eth.heldEnd, 3.5);
    assert.equal(eth.priceStart, 2000);
    assert.equal(eth.priceEnd, 2200);
    assert.ok(Math.abs(eth.priceChangePct! - 0.1) < 1e-9);
    const usdc = r.holdings.find((h) => h.symbol === 'USDC')!;
    assert.equal(usdc.borrowedStart, 1000);
    assert.equal(usdc.borrowedEnd, 3000);
    assert.equal(usdc.usdChange, -2000);
    assert.equal(r.holdings[0].symbol, 'USDC', 'largest |usd change| first');

    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0].healthFactor, 1.24);
    assert.equal(r.positions[0].healthFactorStart, 3.2);
    assert.ok(r.alerts.some((x) => x.code === 'health-factor-low'), JSON.stringify(r.alerts));
    assert.equal(r.alerts[0].level, 'warning', 'most severe first');
    assert.equal(r.activity.count, 0);
  });

  test('stale data and a currency without rates are flagged', () => {
    const db = openDb();
    const a = seed(db);
    slice(db, NOW - 3 * DAY, a, [{ token: WETH, amount: 1, usd: 2000 }]);
    slice(db, NOW - 3 * 3600, a, [{ token: WETH, amount: 1, usd: 2200 }]);
    const r = getReport(db, { addressIds: [a], scope: 'all', window: '7d', currency: 'CHF' }, NOW);
    assert.equal(r.freshness.stale, true);
    assert.ok(r.alerts.some((x) => x.code === 'data-stale'));
    assert.ok(r.alerts.some((x) => x.code === 'fx-missing'));
    assert.equal(r.currency.code, 'USD');
    // history starts 3 days ago: the 7d window starts there
    assert.equal(r.from, NOW - 3 * DAY);
  });

  test('holdingChanges marks new, closed and price-only assets', () => {
    const tt = (key: string, held: number, usd: number, price: number | null = null): TopToken => ({
      key,
      symbol: key,
      name: null,
      logo: null,
      chains: ['arbitrum'],
      amount: held,
      price,
      usd,
      walletUsd: usd,
      suppliedUsd: 0,
      borrowedUsd: 0,
      share: 0,
      heldAmount: held,
      borrowedAmount: 0,
    });
    const out = holdingChanges([tt('A', 1, 10), tt('B', 2, 20)], [tt('B', 2, 24, 12), tt('C', 5, 5, 1)]);
    const by = Object.fromEntries(out.map((h) => [h.key, h]));
    assert.equal(by.A.status, 'closed');
    assert.equal(by.A.usdChange, -10);
    assert.equal(by.B.status, 'price');
    assert.ok(Math.abs(by.B.priceChangePct! - 0.2) < 1e-9);
    assert.equal(by.C.status, 'new');
    assert.equal(by.C.priceStart, null);
  });
});

describe('bot token', () => {
  const req = (auth?: string) => new Request('http://127.0.0.1/api/bot/report', { headers: auth ? { authorization: auth } : {} });
  const token = 'x'.repeat(32);

  test('disabled without a token, 401 on a wrong one, passes with the right one', () => {
    const prev = process.env.BOT_API_TOKEN;
    try {
      delete process.env.BOT_API_TOKEN;
      assert.equal(requireBotToken(req(`Bearer ${token}`))?.status, 503);
      process.env.BOT_API_TOKEN = 'short';
      assert.equal(requireBotToken(req('Bearer short'))?.status, 503, 'too short tokens are refused');
      process.env.BOT_API_TOKEN = token;
      assert.equal(requireBotToken(req())?.status, 401);
      assert.equal(requireBotToken(req('Bearer nope'))?.status, 401);
      assert.equal(requireBotToken(req(token))?.status, 401, 'Bearer prefix required');
      assert.equal(requireBotToken(req(`Bearer ${token}`)), null);
    } finally {
      if (prev === undefined) delete process.env.BOT_API_TOKEN;
      else process.env.BOT_API_TOKEN = prev;
    }
  });
});
