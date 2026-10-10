// Curve crvUSD / LlamaLend valuation math and registry helpers (synthetic data, no network).
// Run: NODE_OPTIONS=--experimental-sqlite npx tsx --test lib/protocols/__tests__/curve-crvusd.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../db/migrate';
import {
  CRVUSD_KEY,
  CRVUSD_TOKEN,
  applyCurveToEntries,
  curveContracts,
  curveMarketKey,
  curveProtocolTotals,
  curveTokenPriceKey,
  decodeInt256,
  getCurvePairs,
  healthToAaveLike,
  isCurvePositionKind,
  loadCurveMarkets,
  rateToApy,
  valueCurvePoint,
  valueCurvePosition,
  type CurveMarket,
  type CurvePointRead,
} from '../curve-crvusd';
import type { Db } from '../../history/types';

const E18 = 10n ** 18n;
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';

function market(over: Partial<CurveMarket> = {}): CurveMarket {
  return {
    chain: 'ethereum',
    kind: 'mint',
    idx: 3,
    controller: '0x5a5a00000000000000000000000000000000c001',
    amm: '0x5a5a00000000000000000000000000000000a001',
    vault: null,
    collateral: WETH,
    borrowed: CRVUSD_TOKEN.ethereum,
    collateralSymbol: 'WETH',
    borrowedSymbol: 'crvUSD',
    collateralDecimals: 18,
    borrowedDecimals: 18,
    collateralKey: 'coingecko:ethereum',
    borrowedKey: CRVUSD_KEY,
    market: 'eth-crvusd-3-weth',
    protocol: 'curve-crvusd',
    ...over,
  };
}

describe('valueCurvePosition', () => {
  test('WETH collateral against crvUSD debt: supply + negative borrow row, net = collateral - debt', () => {
    const m = market();
    const v = valueCurvePosition(m, { collateralRaw: 50n * E18, stableRaw: 0n, debtRaw: 120_000n * E18, healthRaw: (E18 * 25n) / 100n }, 3_000, 1);
    assert.ok(v);
    assert.equal(v.collateral, 50);
    assert.equal(v.debt, 120_000);
    assert.equal(v.collateralUsd, 150_000);
    assert.equal(v.debtUsd, 120_000);
    assert.equal(v.netUsd, 30_000);
    assert.equal(v.health, 0.25);
    assert.deepEqual(
      v.rows.map((r) => [r.token, r.side, r.amount, r.usd, r.protocol]),
      [
        [m.amm, 'supply', 50, 150_000, 'curve-crvusd'],
        [m.controller, 'borrow', 120_000, -120_000, 'curve-crvusd'],
      ],
    );
  });

  test('soft liquidation: crvUSD in the bands is a supply row on the controller and counts toward net', () => {
    const m = market();
    const v = valueCurvePosition(m, { collateralRaw: 40n * E18, stableRaw: 10_000n * E18, debtRaw: 100_000n * E18, healthRaw: null }, 2_500, 1);
    assert.ok(v);
    assert.equal(v.rows.length, 3);
    const stable = v.rows.find((r) => r.side === 'supply' && r.token === m.controller);
    assert.ok(stable);
    assert.equal(stable.amount, 10_000);
    assert.equal(v.collateralUsd, 110_000);
    assert.equal(v.netUsd, 10_000);
    assert.equal(v.health, null); // health unreadable
  });

  test('8 decimal collateral (WBTC) and a LlamaLend market', () => {
    const m = market({ kind: 'lend', protocol: 'llamalend', collateral: WBTC, collateralSymbol: 'WBTC', collateralDecimals: 8, collateralKey: 'coingecko:wrapped-bitcoin' });
    const v = valueCurvePosition(m, { collateralRaw: 150_000_000n, stableRaw: 0n, debtRaw: 50_000n * E18, healthRaw: E18 }, 60_000, 0.999);
    assert.ok(v);
    assert.equal(v.collateral, 1.5);
    assert.equal(v.collateralUsd, 90_000);
    assert.equal(v.debtUsd, 49_950);
    assert.ok(v.rows.every((r) => r.protocol === 'llamalend'));
  });

  test('empty position (no loan / closed) yields null, unknown prices value at 0', () => {
    assert.equal(valueCurvePosition(market(), { collateralRaw: 0n, stableRaw: 0n, debtRaw: 0n, healthRaw: null }, 3_000, 1), null);
    const v = valueCurvePosition(market(), { collateralRaw: E18, stableRaw: 0n, debtRaw: 0n, healthRaw: null }, null, null);
    assert.ok(v);
    assert.equal(v.collateralUsd, 0);
    assert.equal(v.health, null); // no debt: no health
  });
});

describe('number helpers', () => {
  test('decodeInt256 handles negative health (below the liquidation line)', () => {
    const minus5pct = (1n << 256n) - (E18 * 5n) / 100n;
    assert.equal(decodeInt256(minus5pct), -(E18 * 5n) / 100n);
    assert.equal(decodeInt256(E18), E18);
    assert.equal(healthToAaveLike(-0.05), 0.95);
    assert.equal(healthToAaveLike(0.3), 1.3);
    assert.equal(healthToAaveLike(null), null);
  });

  test('rateToApy compounds a per-second rate', () => {
    // 10% APR per second rate
    const rate = BigInt(Math.round((0.1 / (365 * 86_400)) * 1e18));
    assert.ok(Math.abs(rateToApy(rate) - (Math.exp(0.1) - 1)) < 1e-9);
    assert.equal(rateToApy(0n), 0);
  });

  test('market keys and price keys', () => {
    assert.equal(curveMarketKey('ethereum', 'mint', 3, 'WETH'), 'eth-crvusd-3-weth');
    assert.equal(curveMarketKey('arbitrum', 'lend', 12, 'gm:USDC'), 'arb-llamalend-12-gmusdc');
    assert.equal(curveTokenPriceKey('ethereum', CRVUSD_TOKEN.ethereum.toUpperCase().replace('0X', '0x'), 'crvUSD'), CRVUSD_KEY);
    assert.equal(curveTokenPriceKey('arbitrum', CRVUSD_TOKEN.arbitrum, 'crvUSD'), CRVUSD_KEY);
    assert.equal(curveTokenPriceKey('ethereum', WETH, 'WETH'), 'coingecko:ethereum');
    assert.equal(curveTokenPriceKey('ethereum', '0x5a5a0000000000000000000000000000000000ff', 'WETH'), 'coingecko:ethereum'); // trusted symbol fallback
    assert.ok(isCurvePositionKind('curve-collateral') && isCurvePositionKind('curve-debt') && !isCurvePositionKind('erc20'));
  });
});

describe('valueCurvePoint / applyCurveToEntries', () => {
  const m = market();
  const lend = market({
    kind: 'lend',
    protocol: 'llamalend',
    controller: '0x5a5a00000000000000000000000000000000c002',
    amm: '0x5a5a00000000000000000000000000000000a002',
    collateral: WBTC,
    collateralSymbol: 'WBTC',
    collateralDecimals: 8,
    collateralKey: 'coingecko:wrapped-bitcoin',
    market: 'eth-llamalend-1-wbtc',
  });
  const read: CurvePointRead = {
    states: [
      { a: 0, addressId: 7, market: m, state: { collateralRaw: 10n * E18, stableRaw: 0n, debtRaw: 20_000n * E18, healthRaw: E18 / 2n }, borrowApy: 0.12 },
      { a: 1, addressId: 8, market: lend, state: { collateralRaw: 100_000_000n, stableRaw: 0n, debtRaw: 30_000n * E18, healthRaw: E18 }, borrowApy: null },
    ],
    priceKeys: ['coingecko:ethereum', CRVUSD_KEY, 'coingecko:wrapped-bitcoin'],
  };

  test('crvUSD without a price falls back to $1, other missing keys are reported and valued at 0', () => {
    const missing: string[] = [];
    const prices: Record<string, number> = { 'coingecko:ethereum': 3_000 };
    const vals = valueCurvePoint(read, (k) => prices[k] ?? null, (k) => missing.push(k));
    assert.equal(vals.length, 2);
    assert.equal(vals[0].valued.debtUsd, 20_000); // $1 fallback
    assert.equal(vals[0].valued.netUsd, 10_000);
    assert.equal(vals[1].valued.collateralUsd, 0);
    assert.deepEqual(missing, ['coingecko:wrapped-bitcoin']);
  });

  test('entries get balance rows and one position value per protocol; wallet-only entries are untouched', () => {
    const vals = valueCurvePoint(read, (k) => ({ 'coingecko:ethereum': 3_000, 'coingecko:wrapped-bitcoin': 60_000, [CRVUSD_KEY]: 1 })[k] ?? null);
    const entries = [0, 1, 2].map(() => ({ balances: [] as never[], positions: [] as { protocol: string; usd: number }[] }));
    applyCurveToEntries(entries, vals);
    assert.deepEqual(entries[0].positions, [{ protocol: 'curve-crvusd', usd: 10_000 }]);
    assert.deepEqual(entries[1].positions, [{ protocol: 'llamalend', usd: 30_000 }]);
    assert.equal(entries[2].positions.length, 0);
    assert.equal(entries[0].balances.length, 2);
    // net of the position values equals the sum of the signed balance rows
    const rowsSum = [...entries[0].balances, ...entries[1].balances].reduce((s, r: { usd: number }) => s + r.usd, 0);
    assert.equal(rowsSum, 40_000);
    assert.deepEqual(curveProtocolTotals(vals.map((v) => v.valued)), [
      { protocol: 'curve-crvusd', usd: 10_000 },
      { protocol: 'llamalend', usd: 30_000 },
    ]);
  });
});

describe('registry tables (migration 6)', () => {
  test('curve_markets rows feed loadCurveMarkets and the ledger contract map; pair markers default empty', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db as never);
    const m = market();
    db.prepare(
      `INSERT INTO curve_markets (chain, controller, kind, idx, amm, vault, collateral, borrowed, collateral_symbol, borrowed_symbol,
        collateral_decimals, borrowed_decimals, collateral_key, borrowed_key, market) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.chain, m.controller, m.kind, m.idx, m.amm, null, m.collateral, m.borrowed, 'WETH', 'crvUSD', 18, 18, m.collateralKey, m.borrowedKey, m.market);
    const sdb = db as unknown as Db;
    const list = loadCurveMarkets(sdb, 'ethereum');
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], m);
    assert.equal(loadCurveMarkets(sdb, 'arbitrum').length, 0);
    const map = curveContracts(sdb, 'ethereum');
    assert.equal(map.get(m.controller)?.role, 'controller');
    assert.equal(map.get(m.amm)?.role, 'amm');
    assert.equal(map.get(m.amm)?.market, 'eth-crvusd-3-weth');
    assert.equal(map.get('0xc9332fdcb1c491dcc683bae86fe3cb70360738bc')?.role, 'factory');
    assert.deepEqual(getCurvePairs(sdb, 1, 'ethereum'), { lastBlock: null, pairs: {} });
  });
});
