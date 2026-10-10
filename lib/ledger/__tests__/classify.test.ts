// Classification tests for the transactions ledger (pure functions + the read side on node:sqlite).
// Run: NODE_OPTIONS=--experimental-sqlite npx tsx --test lib/ledger/__tests__/classify.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { classifyTx, type ClassifyContext, type LegInput, type OwnInfo } from '../classify';
import type { QDb } from '../../queries/db';
import { getTransactions } from '../../queries/transactions';
import { getFlowSummary } from '../../queries/flows';

const SAFE = '0x2222222222222222222222222222222222222222';
const EOA = '0x3333333333333333333333333333333333333333';
const EXT = '0x1111111254eeb25477b68fb85ed929f73a960582';
const ROUTER = '0x662c83000000000000000000000000000000beef';
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const AWETH = '0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8';
const AUSDC = '0x724dc807b04555b71ed48a6896b6f41593b8c637';
const VDUSDC = '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6';
const SPAM = '0x5a5a000000000000000000000000000000005a01';

const TOKENS: Record<string, { kind: string; symbol: string; priceKey: string; spam?: boolean }> = {
  [USDC]: { kind: 'erc20', symbol: 'USDC', priceKey: 'coingecko:usd-coin' },
  [WETH]: { kind: 'erc20', symbol: 'WETH', priceKey: 'coingecko:ethereum' },
  [ZERO]: { kind: 'native', symbol: 'ETH', priceKey: 'coingecko:ethereum' },
  [AWETH]: { kind: 'atoken', symbol: 'aWETH', priceKey: 'coingecko:ethereum' },
  [AUSDC]: { kind: 'atoken', symbol: 'aUSDC', priceKey: 'coingecko:usd-coin' },
  [VDUSDC]: { kind: 'vdebt', symbol: 'variableDebtUSDC', priceKey: 'coingecko:usd-coin' },
  [SPAM]: { kind: 'erc20', symbol: 'DeFAI', priceKey: 'arbitrum:spam', spam: true },
};

let seq = 0;
function leg(token: string, from: string, to: string, amount: number, usd: number | null, hint: LegInput['hint'] = token === ZERO ? 'native' : 'erc20'): LegInput {
  const t = TOKENS[token];
  return {
    ref: `log:${seq++}`,
    token,
    from,
    to,
    amountRaw: amount === 0 ? '0' : String(Math.round(amount * 1e6)),
    amount,
    usd,
    hint,
    tokenKind: t?.kind ?? null,
    spam: !!t?.spam,
    symbol: t?.symbol ?? null,
    logo: null,
    priceKey: t?.priceKey ?? null,
  };
}

const OWN = new Map<string, OwnInfo>([
  [SAFE, { id: 1, label: 'Vault Safe' }],
  [EOA, { id: 2, label: 'Cold storage' }],
]);
// eth_getCode cache: EXT is an EOA (exchange, other person), ROUTER a contract
const CODES = new Map<string, boolean>([
  [EXT, false],
  [ROUTER, true],
]);
function ctx(scope: string[]): ClassifyContext {
  return { chain: 'arbitrum', scope: new Set(scope), own: OWN, aTokens: new Set([AWETH, AUSDC]), codes: CODES };
}
const OVERVIEW = ctx([SAFE, EOA]);
const SAFE_ONLY = ctx([SAFE]);
const EOA_ONLY = ctx([EOA]);

describe('internal vs send by scope', () => {
  const tx = [leg(USDC, SAFE, EOA, 5000, 5000)];
  test('Safe -> EOA is internal when both are in scope', () => {
    const c = classifyTx(tx, OVERVIEW);
    assert.equal(c.kind, 'internal');
    assert.equal(c.netUsd, 0);
    assert.equal(c.counterparty, null);
    assert.equal(c.transfers[0].direction, 'internal');
    assert.equal(c.transfers[0].toLabel, 'Cold storage');
  });
  test('the same transfer is a send to an own wallet in the Safe-only scope', () => {
    const c = classifyTx(tx, SAFE_ONLY);
    assert.equal(c.kind, 'send');
    assert.equal(c.netUsd, -5000);
    assert.equal(c.counterparty, EOA);
    assert.equal(c.counterpartyLabel, 'Cold storage');
    assert.equal(c.transfers[0].direction, 'out');
    assert.equal(c.transfers[0].toOwn, true);
  });
  test('and a receive in the EOA-only scope', () => {
    const c = classifyTx(tx, EOA_ONLY);
    assert.equal(c.kind, 'receive');
    assert.equal(c.netUsd, 5000);
    assert.equal(c.counterpartyLabel, 'Vault Safe');
  });
  test('external counterparties: receive / send with netUsd', () => {
    assert.deepEqual(
      (({ kind, netUsd, counterparty, counterpartyLabel }) => ({ kind, netUsd, counterparty, counterpartyLabel }))(classifyTx([leg(ZERO, EXT, EOA, 2, 6000)], OVERVIEW)),
      { kind: 'receive', netUsd: 6000, counterparty: EXT, counterpartyLabel: null },
    );
    const s = classifyTx([leg(USDC, EOA, EXT, 2000, 2000)], OVERVIEW);
    assert.equal(s.kind, 'send');
    assert.equal(s.netUsd, -2000);
  });
});

describe('aave kinds', () => {
  test('supply: aToken minted to the scope, underlying to the reserve', () => {
    const c = classifyTx([leg(WETH, SAFE, AWETH, 3.27, 8407), leg(AWETH, ZERO, SAFE, 3.27, 8407)], SAFE_ONLY);
    assert.equal(c.kind, 'aave-supply');
    assert.equal(c.netUsd, 0);
    assert.equal(c.counterparty, null);
  });
  test('withdraw: aToken burned', () => {
    assert.equal(classifyTx([leg(AWETH, SAFE, ZERO, 10, 30000), leg(WETH, AWETH, SAFE, 10, 30000)], SAFE_ONLY).kind, 'aave-withdraw');
  });
  test('borrow: debt token minted, underlying from the reserve', () => {
    assert.equal(classifyTx([leg(VDUSDC, ZERO, SAFE, 8000, 7998), leg(USDC, AUSDC, SAFE, 8000, 7998)], SAFE_ONLY).kind, 'aave-borrow');
  });
  test('repay: debt token burned', () => {
    assert.equal(classifyTx([leg(VDUSDC, SAFE, ZERO, 4000, 4000), leg(USDC, SAFE, AUSDC, 4000, 4000)], SAFE_ONLY).kind, 'aave-repay');
  });
  test('leverage boost (borrow + swap + supply): largest action wins, fees do not make it a send', () => {
    const c = classifyTx(
      [
        leg(VDUSDC, ZERO, SAFE, 8000, 7998),
        leg(USDC, AUSDC, SAFE, 8000, 7998),
        leg(USDC, SAFE, EXT, 20, 20),
        leg(USDC, SAFE, ROUTER, 7980, 7978),
        leg(WETH, ROUTER, SAFE, 3.27, 8407),
        leg(WETH, SAFE, AWETH, 3.27, 8407),
        leg(AWETH, ZERO, SAFE, 3.27, 8407),
      ],
      SAFE_ONLY,
    );
    assert.equal(c.kind, 'aave-supply');
    assert.equal(c.netUsd, 0);
  });
  test('position close batch that also pays the owner: aave-withdraw in the overview, send in the Safe scope', () => {
    const close = [
      leg(VDUSDC, SAFE, ZERO, 12000, 12000),
      leg(USDC, SAFE, AUSDC, 12000, 12000),
      leg(AWETH, SAFE, ZERO, 10, 30000),
      leg(WETH, AWETH, SAFE, 10, 30000),
      leg(WETH, SAFE, ROUTER, 10, 30000),
      leg(USDC, ROUTER, SAFE, 29950, 29950),
      leg(USDC, SAFE, EOA, 5000, 5000),
    ];
    const o = classifyTx(close, OVERVIEW);
    assert.equal(o.kind, 'aave-withdraw');
    assert.equal(o.netUsd, 0);
    const s = classifyTx(close, SAFE_ONLY);
    assert.equal(s.kind, 'send');
    assert.equal(s.netUsd, -5000);
    assert.equal(s.counterpartyLabel, 'Cold storage');
  });
});

describe('swap, wrap and spam', () => {
  test('swap: one token out, a different one in', () => {
    const c = classifyTx([leg(ZERO, EOA, EXT, 4.7, 16000), leg(USDC, EXT, EOA, 10678, 10678)], OVERVIEW);
    assert.equal(c.kind, 'swap');
    assert.equal(c.netUsd, 0);
    assert.equal(c.counterparty, EXT);
  });
  test('same asset back and forth is not a swap: legs are netted per tx', () => {
    const c = classifyTx([leg(USDC, EOA, EXT, 10, 10), leg(USDC, EXT, EOA, 9, 9)], OVERVIEW);
    assert.equal(c.kind, 'send');
    assert.equal(c.netUsd, -1);
    const zero = classifyTx([leg(USDC, EOA, EXT, 10, 10), leg(USDC, EXT, EOA, 10, 10)], OVERVIEW);
    assert.equal(zero.kind, 'other');
    assert.equal(zero.netUsd, 0);
  });
  test('ETH sent by the owner and wrapped by the Safe is internal, not a phantom WETH deposit', () => {
    // Arbitrum: owner EOA -> Safe 2 ETH (external), WETH minted to the Safe (its ETH -> WETH call is an
    // invisible internal transfer), USDC Safe -> owner EOA
    const tx = [leg(ZERO, EOA, SAFE, 2, 6000), leg(WETH, ZERO, SAFE, 2, 6000), leg(USDC, SAFE, EOA, 1500, 1500)];
    const o = classifyTx(tx, OVERVIEW);
    assert.equal(o.kind, 'internal');
    assert.equal(o.netUsd, 0);
    const s = classifyTx(tx, SAFE_ONLY);
    assert.equal(s.kind, 'receive');
    assert.equal(s.netUsd, 6000 - 1500);
  });
  test('spam tokens and zero value poisoning are spam; spam legs never change a real kind', () => {
    assert.equal(classifyTx([leg(SPAM, EXT, SAFE, 640, null)], OVERVIEW).kind, 'spam');
    assert.equal(classifyTx([leg(USDC, EOA, EXT, 0, 0)], OVERVIEW).kind, 'spam');
    assert.equal(classifyTx([leg(USDC, EXT, EOA, 0.017, 0.017)], OVERVIEW).kind, 'spam');
    const mixed = classifyTx([leg(SPAM, EXT, SAFE, 640, null), leg(USDC, EXT, SAFE, 100, 100)], OVERVIEW);
    assert.equal(mixed.kind, 'receive');
    assert.equal(mixed.transfers.length, 1);
  });
  test('approval only and unpriced receives', () => {
    assert.equal(classifyTx([leg(USDC, EOA, SAFE, 0, null, 'approval')], EOA_ONLY).kind, 'approval');
    assert.equal(classifyTx([leg(USDC, EXT, EOA, 5, null)], OVERVIEW).netUsd, null);
  });
});

// ---------------------------------------------------------------------------------------------
// read side: getTransactions / getFlowSummary on a temp database

const SCHEMA = `
CREATE TABLE wallets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE addresses (id INTEGER PRIMARY KEY, address TEXT NOT NULL UNIQUE, label TEXT, chains TEXT, is_contract TEXT, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE wallet_addresses (wallet_id INTEGER NOT NULL, address_id INTEGER NOT NULL, PRIMARY KEY (wallet_id, address_id));
CREATE TABLE tokens (chain TEXT NOT NULL, address TEXT NOT NULL, symbol TEXT, name TEXT, decimals INTEGER, kind TEXT, underlying TEXT, market TEXT, price_key TEXT, logo TEXT, spam INTEGER DEFAULT 0, PRIMARY KEY (chain, address));
CREATE TABLE jobs (id INTEGER PRIMARY KEY, type TEXT NOT NULL, payload TEXT, status TEXT, progress INTEGER, total INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE tx (chain TEXT NOT NULL, hash TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL, from_addr TEXT, receipt INTEGER DEFAULT 0, fee_wei TEXT, fee_usd REAL, PRIMARY KEY (chain, hash));
CREATE TABLE tx_transfers (chain TEXT NOT NULL, hash TEXT NOT NULL, ref TEXT NOT NULL, token TEXT NOT NULL, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, amount_raw TEXT, amount REAL, usd REAL, kind_hint TEXT NOT NULL, PRIMARY KEY (chain, hash, ref));
CREATE TABLE tx_addresses (address_id INTEGER NOT NULL, chain TEXT NOT NULL, hash TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (address_id, chain, hash));
CREATE TABLE ledger_state (address_id INTEGER NOT NULL, chain TEXT NOT NULL, last_block INTEGER, native_block INTEGER, updated_at INTEGER, error TEXT, PRIMARY KEY (address_id, chain));
CREATE TABLE address_code (chain TEXT NOT NULL, address TEXT NOT NULL, is_contract INTEGER NOT NULL, checked_at INTEGER NOT NULL, PRIMARY KEY (chain, address));
CREATE TABLE bridge_pairs (l1_hash TEXT NOT NULL, l1_ref TEXT NOT NULL, l1_addr TEXT NOT NULL, l2_hash TEXT NOT NULL, l2_ref TEXT NOT NULL,
  l2_addr TEXT NOT NULL, direction TEXT NOT NULL, PRIMARY KEY (l1_hash, l1_ref));
CREATE UNIQUE INDEX bridge_pairs_l2 ON bridge_pairs(l2_hash, l2_ref);
`;

function seedDb(): QDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(`INSERT INTO wallets (id, name, sort) VALUES (1, 'Main', 0), (2, 'Cold storage', 1);
    INSERT INTO addresses (id, address, label, chains) VALUES (1, '${SAFE}', 'Vault Safe', '["arbitrum"]'), (2, '${EOA}', NULL, '["arbitrum"]');
    INSERT INTO wallet_addresses VALUES (1, 1), (2, 2);
    INSERT INTO ledger_state (address_id, chain, last_block) VALUES (1, 'arbitrum', 100), (2, 'arbitrum', 100);
    INSERT INTO address_code VALUES ('arbitrum', '${EXT}', 0, 1), ('arbitrum', '${ROUTER}', 1, 1);`);
  for (const [a, t] of Object.entries(TOKENS)) {
    d.prepare('INSERT INTO tokens (chain, address, symbol, kind, price_key, spam, decimals) VALUES (?, ?, ?, ?, ?, ?, 18)').run('arbitrum', a, t.symbol, t.kind, t.priceKey, t.spam ? 1 : 0);
  }
  const txs: { ts: number; legs: [string, string, string, number, number | null][]; from?: string; fee?: number }[] = [
    { ts: 1000, legs: [[ZERO, EXT, EOA, 4, 12000]] }, // deposit from outside to the EOA
    { ts: 2000, legs: [[ZERO, EOA, SAFE, 3.5, 10500], [WETH, ZERO, SAFE, 3.5, 10500]], from: EOA, fee: 0.25 }, // fund the Safe
    { ts: 3000, legs: [[SPAM, EXT, SAFE, 640, null]] }, // airdrop spam
    { ts: 4000, legs: [[WETH, SAFE, AWETH, 3.5, 10500], [AWETH, ZERO, SAFE, 3.5, 10500]] }, // supply
    { ts: 5000, legs: [[USDC, SAFE, EOA, 1000, 1000]] }, // Safe -> EOA
    { ts: 6000, legs: [[USDC, EOA, EXT, 500, 500]] }, // withdraw to outside
  ];
  txs.forEach((t, i) => {
    const hash = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    d.prepare('INSERT INTO tx (chain, hash, block, ts, from_addr, fee_usd) VALUES (?, ?, ?, ?, ?, ?)').run('arbitrum', hash, i + 1, t.ts, t.from ?? null, t.fee ?? null);
    t.legs.forEach(([token, from, to, amount, usd], j) => {
      d.prepare('INSERT INTO tx_transfers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('arbitrum', hash, `log:${j}`, token, from, to, String(amount * 1e6), amount, usd, token === ZERO ? 'native' : 'erc20');
      for (const [addr, id] of [[SAFE, 1], [EOA, 2]] as const) {
        if (from === addr || to === addr) d.prepare('INSERT OR IGNORE INTO tx_addresses VALUES (?, ?, ?, ?)').run(id, 'arbitrum', hash, t.ts);
      }
    });
  });
  return d as unknown as QDb;
}

describe('getTransactions / getFlowSummary', () => {
  test('overview: newest first, spam hidden, internal transfers are internal and do not count as flows', () => {
    const db = seedDb();
    const r = getTransactions(db, { addressIds: [1, 2] });
    assert.deepEqual(
      r.items.map((x) => x.kind),
      ['send', 'internal', 'aave-supply', 'internal', 'receive'],
    );
    assert.equal(r.items[3].feeUsd, 0.25);
    assert.equal(r.syncing, false);
    assert.deepEqual(r.flows, { depositsUsd: 12000, withdrawalsUsd: 500, netDepositsUsd: 11500, sinceTs: 1000 });
    assert.equal(getTransactions(db, { addressIds: [1, 2], hideSpam: false }).items.length, 6);
    assert.equal(getTransactions(db, { addressIds: [1, 2], hideInternal: true }).items.length, 3);
  });
  test('Safe-only scope: funding from the owner EOA is a deposit, the payout a withdrawal', () => {
    const db = seedDb();
    const r = getTransactions(db, { addressIds: [1], kinds: ['send', 'receive'] });
    assert.deepEqual(
      r.items.map((x) => [x.kind, x.counterpartyLabel, x.netUsd]),
      [
        ['send', 'Cold storage', -1000],
        ['receive', 'Cold storage', 10500],
      ],
    );
    assert.equal(r.items[1].feeUsd, null); // gas was paid by the EOA, outside this scope
    assert.deepEqual(getFlowSummary(db, [1]), { depositsUsd: 10500, withdrawalsUsd: 1000, netDepositsUsd: 9500, sinceTs: 2000 });
  });
  test('cursor pagination never skips or repeats rows', () => {
    const db = seedDb();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = getTransactions(db, { addressIds: [1, 2], limit: 2, cursor, hideSpam: false, withFlows: false });
      seen.push(...r.items.map((x) => x.hash));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6);
  });
});

describe('curve crvUSD / LlamaLend loan legs', () => {
  const CTRL = '0x5a5a00000000000000000000000000000000c001';
  const AMM = '0x5a5a00000000000000000000000000000000a001';
  const CRVUSD = '0x5a5a00000000000000000000000000000000c0d0';
  TOKENS[CRVUSD] = { kind: 'erc20', symbol: 'crvUSD', priceKey: 'coingecko:crvusd' };
  const curve = new Map([
    [CTRL, { role: 'controller' as const, borrowed: CRVUSD }],
    [AMM, { role: 'amm' as const, borrowed: CRVUSD }],
  ]);
  const c = (scope: string[]): ClassifyContext => ({ ...ctx(scope), curve });
  test('create loan: collateral to the AMM, crvUSD from the controller is a borrow, never a flow', () => {
    const r = classifyTx([leg(WETH, EOA, AMM, 10, 30000), leg(CRVUSD, CTRL, EOA, 20000, 20000)], c([EOA]));
    assert.equal(r.kind, 'curve-borrow');
    assert.equal(r.netUsd, 0);
  });
  test('repay, add collateral, close: the debt action names the tx', () => {
    assert.equal(classifyTx([leg(CRVUSD, EOA, CTRL, 5000, 5000)], c([EOA])).kind, 'curve-repay');
    assert.equal(classifyTx([leg(WETH, EOA, AMM, 2, 6000)], c([EOA])).kind, 'curve-deposit');
    const close = classifyTx([leg(CRVUSD, EOA, CTRL, 20000, 20000), leg(WETH, AMM, EOA, 10, 30000)], c([EOA]));
    assert.equal(close.kind, 'curve-repay');
    assert.equal(classifyTx([leg(WETH, AMM, EOA, 1, 3000)], c([EOA])).kind, 'curve-withdraw');
  });
  test('without the registry the same legs are a contract interaction (swap), not a deposit', () => {
    const r = classifyTx([leg(WETH, EOA, AMM, 10, 30000), leg(CRVUSD, CTRL, EOA, 20000, 20000)], ctx([EOA]));
    assert.equal(r.kind, 'swap');
  });
  test('own legs still win: owner EOA funding a proxy that borrows is a receive in the proxy-only scope', () => {
    const r = classifyTx([leg(ZERO, EOA, SAFE, 1, 3000), leg(CRVUSD, CTRL, SAFE, 20000, 20000)], c([SAFE]));
    assert.equal(r.kind, 'receive');
    assert.equal(r.netUsd, 3000);
  });
});
