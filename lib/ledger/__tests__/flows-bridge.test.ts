// Deposits / withdrawals only from EOAs, Arbitrum bridge aliasing and pairing, approvals filter.
// Run: NODE_OPTIONS=--experimental-sqlite npx tsx --test lib/ledger/__tests__/flows-bridge.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyL1ToL2Alias, pairBridgeLegs, rebuildBridgePairs, undoL1ToL2Alias, type BridgeLeg } from '../bridge';
import { classifyTx, type ClassifyContext, type LegInput, type OwnInfo } from '../classify';
import { isContractCode } from '../ingest';
import type { Chain } from '../../queries/api-types';
import type { QDb } from '../../queries/db';
import { getFlowSummary } from '../../queries/flows';
import { getTransactions } from '../../queries/transactions';

const EOA = '0x5a5a00000000000000000000000000000000a001';
const PROXY = '0x5a5a00000000000000000000000000000000b002'; // tracked smart wallet (DSProxy / Safe)
const CEX = '0x5a5a00000000000000000000000000000000c003'; // exchange hot wallet, an EOA
const CEX_CONTRACT = '0x5a5a00000000000000000000000000000000c004'; // exchange hot wallet, a contract
const PROTOCOL = '0x5a5a00000000000000000000000000000000d005'; // lending market / router
const FRIEND = '0x5a5a00000000000000000000000000000000e006'; // untracked EOA
const UNKNOWN = '0x5a5a00000000000000000000000000000000f007'; // code not checked yet
const ZERO = '0x0000000000000000000000000000000000000000';
const INBOX = '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f';
const L1_BRIDGE = '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a';
const ARBSYS = '0x0000000000000000000000000000000000000064';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const CRVUSD = '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e';

let seq = 0;
function leg(token: string, from: string, to: string, usd: number | null, amount = usd ?? 1): LegInput {
  const native = token === ZERO;
  return {
    ref: `log:${seq++}`,
    token,
    from,
    to,
    amountRaw: String(Math.round(amount * 1e6)),
    amount,
    usd,
    hint: native ? 'native' : 'erc20',
    tokenKind: native ? 'native' : 'erc20',
    spam: false,
    symbol: native ? 'ETH' : token === USDC ? 'USDC' : 'crvUSD',
    logo: null,
    priceKey: native ? 'coingecko:ethereum' : token === USDC ? 'coingecko:usd-coin' : 'coingecko:crvusd',
  };
}

const OWN = new Map<string, OwnInfo>([
  [EOA, { id: 1, label: 'Owner' }],
  [PROXY, { id: 2, label: 'Proxy' }],
]);
const CODES = new Map<string, boolean>([
  [CEX, false],
  [FRIEND, false],
  [CEX_CONTRACT, true],
  [PROTOCOL, true],
  [PROXY, true],
]);
function ctx(scope: string[], chain: Chain = 'ethereum'): ClassifyContext {
  return { chain, scope: new Set(scope), own: OWN, aTokens: new Set(), codes: CODES };
}
const ALL = ctx([EOA, PROXY]);

describe('counterparty code decides deposits / withdrawals', () => {
  test('value from / to an EOA is a receive / send', () => {
    assert.deepEqual(
      (({ kind, netUsd }) => ({ kind, netUsd }))(classifyTx([leg(USDC, CEX, EOA, 5000)], ALL, CEX)),
      { kind: 'receive', netUsd: 5000 },
    );
    const s = classifyTx([leg(ZERO, EOA, FRIEND, 3000, 1)], ALL, EOA);
    assert.equal(s.kind, 'send');
    assert.equal(s.netUsd, -3000);
  });
  test('value to / from a contract is a protocol interaction (other), never a flow', () => {
    // borrow from a lending market by the tracked proxy, initiated by the owner EOA
    const borrow = classifyTx([leg(CRVUSD, PROTOCOL, PROXY, 20000), leg(CRVUSD, PROXY, EOA, 20000)], ALL, EOA);
    assert.equal(borrow.kind, 'other');
    const deposit = classifyTx([leg(ZERO, EOA, PROTOCOL, 10000, 4)], ALL, EOA);
    assert.equal(deposit.kind, 'other');
    assert.equal(deposit.netUsd, -10000);
  });
  test('a counterparty whose code is unknown is not a flow; 0x0 mints are not deposits', () => {
    assert.equal(classifyTx([leg(USDC, EOA, UNKNOWN, 100)], ALL, EOA).kind, 'other');
    assert.equal(classifyTx([leg(CRVUSD, ZERO, EOA, 100), leg(USDC, EOA, PROTOCOL, 100)], ALL, EOA).kind, 'swap');
    assert.equal(classifyTx([leg(CRVUSD, ZERO, EOA, 100)], ALL, EOA).kind, 'other');
  });
  test('a payout pushed by a contract in a tx no tracked address sent is a receive (exchange hot wallet)', () => {
    const c = classifyTx([leg(USDC, CEX_CONTRACT, EOA, 35000)], ALL, '0x5a5a0000000000000000000000000000000000ff');
    assert.equal(c.kind, 'receive');
    assert.equal(c.netUsd, 35000);
    assert.equal(classifyTx([leg(USDC, CEX_CONTRACT, EOA, 35000)], ALL, EOA).kind, 'other');
  });
  test('flash loan legs with EOAs net out per tx', () => {
    const c = classifyTx([leg(USDC, FRIEND, PROXY, 50000), leg(USDC, PROXY, FRIEND, 50000)], ALL, EOA);
    assert.equal(c.kind, 'other');
    assert.equal(c.netUsd, 0);
  });
  test('transfers between the owner EOA and its smart wallet are internal', () => {
    const c = classifyTx([leg(ZERO, EOA, PROXY, 7000, 3)], ALL, EOA);
    assert.equal(c.kind, 'internal');
    assert.equal(classifyTx([leg(ZERO, EOA, PROXY, 7000, 3)], ctx([PROXY]), EOA).kind, 'receive');
  });
  test('isContractCode: empty code and EIP-7702 delegations are EOAs', () => {
    assert.equal(isContractCode('0x'), false);
    assert.equal(isContractCode(null), false);
    assert.equal(isContractCode(`0xef0100${'ab'.repeat(20)}`), false);
    assert.equal(isContractCode('0x6080604052'), true);
    assert.equal(isContractCode('0xfe'), true);
  });
});

describe('Arbitrum bridge', () => {
  test('alias math: + 0x1111...1111 mod 2^160 and back', () => {
    assert.equal(applyL1ToL2Alias(ZERO), '0x1111000000000000000000000000000000001111');
    assert.equal(applyL1ToL2Alias('0xffffffffffffffffffffffffffffffffffffffff'), '0x1111000000000000000000000000000000001110');
    assert.equal(undoL1ToL2Alias('0x1111000000000000000000000000000000001110'), '0xffffffffffffffffffffffffffffffffffffffff');
    assert.equal(undoL1ToL2Alias(applyL1ToL2Alias(EOA)), EOA);
    assert.equal(applyL1ToL2Alias(EOA), '0x6b6b00000000000000000000000000000000b112');
  });
  test('ETH arriving on Arbitrum from the alias of a tracked L1 address is internal / own', () => {
    const tx = [leg(ZERO, applyL1ToL2Alias(EOA), EOA, 6000, 2)];
    assert.equal(classifyTx(tx, ctx([EOA, PROXY], 'arbitrum')).kind, 'internal');
    const toProxy = classifyTx([leg(ZERO, applyL1ToL2Alias(EOA), PROXY, 6000, 2)], ctx([PROXY], 'arbitrum'));
    assert.equal(toProxy.kind, 'receive');
    assert.equal(toProxy.counterparty, EOA);
  });
  test('an unpaired bridge leg counts once as a withdrawal / deposit', () => {
    assert.equal(classifyTx([leg(ZERO, EOA, INBOX, 6000, 2)], ALL, EOA).kind, 'send');
    assert.equal(classifyTx([leg(ZERO, L1_BRIDGE, EOA, 6000, 2)], ALL, null).kind, 'receive');
    assert.equal(classifyTx([leg(ZERO, EOA, ARBSYS, 6000, 2)], ctx([EOA], 'arbitrum'), EOA).kind, 'send');
  });

  const bl = (p: Partial<BridgeLeg> & Pick<BridgeLeg, 'chain' | 'dir' | 'ts' | 'amount'>): BridgeLeg => ({
    hash: `0x${(seq++).toString(16).padStart(64, '0')}`,
    ref: 'external',
    asset: 'coingecko:ethereum',
    own: EOA,
    ...p,
  });
  test('pairing: deposits within hours by alias, withdrawals after the challenge period, one to one', () => {
    const alias = EOA;
    const d1 = bl({ chain: 'ethereum', dir: 'out', ts: 1000, amount: 2 });
    const d2 = bl({ chain: 'ethereum', dir: 'out', ts: 1100, amount: 2 });
    const a1 = bl({ chain: 'arbitrum', dir: 'in', ts: 1700, amount: 2, l1Sender: alias });
    const a2 = bl({ chain: 'arbitrum', dir: 'in', ts: 1800, amount: 2, l1Sender: alias });
    const stranger = bl({ chain: 'arbitrum', dir: 'in', ts: 1200, amount: 2, l1Sender: FRIEND }); // someone else's ETH
    const late = bl({ chain: 'arbitrum', dir: 'in', ts: 1000 + 7 * 3600, amount: 1, l1Sender: alias });
    const w = bl({ chain: 'arbitrum', dir: 'out', ts: 5000, amount: 1.5 });
    const wl1 = bl({ chain: 'ethereum', dir: 'in', ts: 5000 + 7 * 86400, amount: 1.5 });
    const pairs = pairBridgeLegs([d1, d2, a1, a2, stranger, late, w, wl1]);
    assert.equal(pairs.length, 3);
    assert.deepEqual(
      pairs.map((p) => [p.direction, p.l1.hash, p.l2.hash]),
      [
        ['deposit', d1.hash, a1.hash],
        ['deposit', d2.hash, a2.hash],
        ['withdrawal', wl1.hash, w.hash],
      ],
    );
    // amount must match within fees, asset must match
    assert.equal(pairBridgeLegs([d1, bl({ chain: 'arbitrum', dir: 'in', ts: 1500, amount: 1.9, l1Sender: alias })]).length, 0);
    assert.equal(pairBridgeLegs([d1, bl({ chain: 'arbitrum', dir: 'in', ts: 1500, amount: 2, l1Sender: alias, asset: 'coingecko:usd-coin' })]).length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// read side

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

type Seed = { chain: Chain; ts: number; from?: string; legs: [string, string, string, number, number | null, string?][] };

function seedDb(txs: Seed[]): QDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(`INSERT INTO wallets (id, name) VALUES (1, 'Main');
    INSERT INTO addresses (id, address, chains) VALUES (1, '${EOA}', '["ethereum","arbitrum"]'), (2, '${PROXY}', '["ethereum"]');
    INSERT INTO wallet_addresses VALUES (1, 1), (1, 2);
    INSERT INTO ledger_state (address_id, chain, last_block) VALUES (1, 'ethereum', 1), (1, 'arbitrum', 1), (2, 'ethereum', 1);`);
  for (const [a, c] of CODES) for (const chain of ['ethereum', 'arbitrum']) d.prepare('INSERT INTO address_code VALUES (?, ?, ?, 1)').run(chain, a, c ? 1 : 0);
  for (const chain of ['ethereum', 'arbitrum']) {
    d.prepare("INSERT INTO tokens (chain, address, symbol, kind, price_key, decimals) VALUES (?, ?, 'ETH', 'native', 'coingecko:ethereum', 18)").run(chain, ZERO);
    d.prepare("INSERT INTO tokens (chain, address, symbol, kind, price_key, decimals) VALUES (?, ?, 'USDC', 'erc20', 'coingecko:usd-coin', 6)").run(chain, USDC);
  }
  txs.forEach((t, i) => {
    const hash = `0x${(i + 1).toString(16).padStart(64, '0')}`;
    d.prepare('INSERT INTO tx (chain, hash, block, ts, from_addr) VALUES (?, ?, ?, ?, ?)').run(t.chain, hash, i + 1, t.ts, t.from ?? null);
    t.legs.forEach(([token, from, to, amount, usd, hint], j) => {
      d.prepare('INSERT INTO tx_transfers VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        t.chain,
        hash,
        `log:${j}`,
        token,
        from,
        to,
        String(amount * 1e6),
        amount,
        usd,
        hint ?? (token === ZERO ? 'native' : 'erc20'),
      );
      for (const [addr, id] of [[EOA, 1], [PROXY, 2]] as const) {
        if (from === addr || to === addr) d.prepare('INSERT OR IGNORE INTO tx_addresses VALUES (?, ?, ?, ?)').run(id, t.chain, hash, t.ts);
      }
    });
  });
  return d as unknown as QDb;
}

describe('flows and bridge pairing on the read side', () => {
  const txs: Seed[] = [
    { chain: 'ethereum', ts: 1000, from: CEX, legs: [[USDC, CEX, EOA, 20000, 20000]] }, // deposit from an exchange
    { chain: 'ethereum', ts: 2000, from: EOA, legs: [[ZERO, EOA, PROXY, 5, 15000]] }, // fund the proxy
    { chain: 'ethereum', ts: 2100, from: EOA, legs: [[USDC, PROTOCOL, PROXY, 9000, 9000], [USDC, PROXY, EOA, 9000, 9000]] }, // borrow, paid out to the owner
    { chain: 'ethereum', ts: 3000, from: EOA, legs: [[ZERO, EOA, INBOX, 2, 6000]] }, // bridge to Arbitrum
    { chain: 'arbitrum', ts: 3600, from: applyL1ToL2Alias(EOA), legs: [[ZERO, applyL1ToL2Alias(EOA), EOA, 2, 6000]] }, // arrives
    { chain: 'ethereum', ts: 4000, from: EOA, legs: [[ZERO, EOA, INBOX, 1, 3000]] }, // bridge to an untracked address
    { chain: 'ethereum', ts: 5000, from: EOA, legs: [[USDC, EOA, FRIEND, 1000, 1000]] }, // pay someone
    { chain: 'ethereum', ts: 6000, from: EOA, legs: [[USDC, EOA, PROTOCOL, 0, null, 'approval']] }, // approval
    { chain: 'ethereum', ts: 6100, from: EOA, legs: [[ZERO, EOA, PROTOCOL, 0, 0, 'call']] }, // zero value contract call
  ];
  test('only EOA and unpaired bridge value counts; paired bridge legs are internal', () => {
    const db = seedDb(txs);
    assert.equal(rebuildBridgePairs(db, new Set([EOA, PROXY])), 1);
    const r = getTransactions(db, { addressIds: [1, 2], withFlows: true });
    assert.deepEqual(
      r.items.map((x) => [x.chain, x.ts, x.kind]),
      [
        ['ethereum', 5000, 'send'],
        ['ethereum', 4000, 'send'],
        ['arbitrum', 3600, 'internal'],
        ['ethereum', 3000, 'internal'],
        ['ethereum', 2100, 'other'],
        ['ethereum', 2000, 'internal'],
        ['ethereum', 1000, 'receive'],
      ],
    );
    assert.deepEqual(r.flows, { depositsUsd: 20000, withdrawalsUsd: 4000, netDepositsUsd: 16000, sinceTs: 1000 });
    // FRONTEND: both legs of the paired deposit carry the bridge direction, nothing else does
    const deposit = { from: 'ethereum', to: 'arbitrum' };
    assert.deepEqual(
      r.items.map((x) => x.bridge ?? null),
      [null, null, deposit, deposit, null, null, null],
    );
    // the proxy alone: funding from the owner EOA is a deposit into it, the loan is not a flow
    assert.deepEqual(getFlowSummary(db, [2]), { depositsUsd: 15000, withdrawalsUsd: 9000, netDepositsUsd: 6000, sinceTs: 2000 });
  });
  test('a WETH unwrap before an ArbSys withdrawal does not take the L1 payout', () => {
    const WETH_ARB = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
    const db = seedDb([
      { chain: 'arbitrum', ts: 10_000, from: EOA, legs: [[WETH_ARB, EOA, ZERO, 1, 3000], [ZERO, WETH_ARB, EOA, 1, 3000]] }, // unwrap
      { chain: 'arbitrum', ts: 10_600, from: EOA, legs: [[ZERO, EOA, ARBSYS, 1, 3000]] }, // withdraw to L1
      { chain: 'ethereum', ts: 10_000 + 8 * 86400, from: EOA, legs: [[ZERO, L1_BRIDGE, EOA, 1, 3000]] }, // claim
    ]);
    assert.equal(rebuildBridgePairs(db, new Set([EOA, PROXY])), 1);
    const pair = db.prepare('SELECT l2_hash FROM bridge_pairs').get() as { l2_hash: string };
    assert.equal(pair.l2_hash, `0x${(2).toString(16).padStart(64, '0')}`);
    const r = getTransactions(db, { addressIds: [1, 2], withFlows: true });
    assert.deepEqual(r.items.map((x) => x.kind), ['internal', 'internal', 'other']);
    const withdrawal = { from: 'arbitrum', to: 'ethereum' };
    assert.deepEqual(r.items.map((x) => x.bridge ?? null), [withdrawal, withdrawal, null]);
    assert.deepEqual(r.flows, { depositsUsd: 0, withdrawalsUsd: 0, netDepositsUsd: 0, sinceTs: 10_000 });
  });
  test('approvals and zero value contract calls are hidden unless asked for', () => {
    const db = seedDb(txs);
    const all = getTransactions(db, { addressIds: [1, 2], includeApprovals: true, withFlows: false });
    assert.deepEqual(all.items.slice(0, 2).map((x) => x.kind), ['other', 'approval']);
    assert.equal(getTransactions(db, { addressIds: [1, 2], kinds: ['approval'], withFlows: false }).items.length, 1);
  });
});
