// Smart wallet suggestions: dedupe, tracked filter, accept / dismiss (lib/queries/suggestions.ts).
// Run: NODE_OPTIONS=--experimental-sqlite npx tsx --test lib/ledger/__tests__/smart-wallets.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { QDb } from '../../queries/db';
import { actOnSuggestion, getSuggestions, upsertSuggestion } from '../../queries/suggestions';

const OWNER = '0x5a5a00000000000000000000000000000000a001';
const OWNER2 = '0x5a5a00000000000000000000000000000000a002';
const SAFE = '0x5a5a00000000000000000000000000000000b001';
const PROXY = '0x5a5a00000000000000000000000000000000c001';
const OTHER = '0x5a5a00000000000000000000000000000000d001';

const SCHEMA = `
CREATE TABLE wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, sort INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, label TEXT, chains TEXT, is_contract TEXT, excluded INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE wallet_addresses (wallet_id INTEGER NOT NULL, address_id INTEGER NOT NULL, PRIMARY KEY (wallet_id, address_id));
CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, payload TEXT, status TEXT, progress INTEGER, total INTEGER, error TEXT, created_at INTEGER, updated_at INTEGER);
CREATE TABLE smart_wallet_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, address TEXT NOT NULL,
  owner_address_id INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, updated_at INTEGER,
  UNIQUE (chain, address));
`;

function seed(): QDb {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.exec(`INSERT INTO wallets (id, name, sort) VALUES (1, 'Hardware', 0), (2, 'Shared', 1);
    INSERT INTO addresses (id, address, chains) VALUES (1, '${OWNER}', '["ethereum","arbitrum"]'), (2, '${OWNER2}', '["ethereum"]'),
      (3, '${OTHER}', '["ethereum"]');
    INSERT INTO wallet_addresses VALUES (1, 1), (2, 1), (2, 2), (2, 3);`);
  return d as unknown as QDb;
}

describe('smart wallet suggestions', () => {
  test('one suggestion per (chain, address) across runs and owners', () => {
    const db = seed();
    assert.equal(upsertSuggestion(db, { chain: 'ethereum', address: PROXY, ownerAddressId: 1, source: 'dsproxy' }, 100), true);
    assert.equal(upsertSuggestion(db, { chain: 'ethereum', address: PROXY.toUpperCase().replace('0X', '0x'), ownerAddressId: 1, source: 'dsproxy' }, 200), false);
    assert.equal(upsertSuggestion(db, { chain: 'ethereum', address: PROXY, ownerAddressId: 2, source: 'dsproxy' }, 300), false);
    assert.equal(upsertSuggestion(db, { chain: 'arbitrum', address: SAFE, ownerAddressId: 1, source: 'safe' }, 100), true);
    assert.equal(upsertSuggestion(db, { chain: 'ethereum', address: SAFE, ownerAddressId: 1, source: 'safe' }, 100), true);
    const s = getSuggestions(db);
    assert.deepEqual(
      s.map((x) => [x.chain, x.address, x.source, x.owner.addressId]),
      [
        ['ethereum', PROXY, 'dsproxy', 1],
        ['arbitrum', SAFE, 'safe', 1],
        ['ethereum', SAFE, 'safe', 1],
      ],
    );
    assert.deepEqual(s[0].wallets.map((w) => ({ ...w })), [
      { id: 1, name: 'Hardware' },
      { id: 2, name: 'Shared' },
    ]);
  });
  test('already tracked addresses (on that chain) are not suggested', () => {
    const db = seed();
    upsertSuggestion(db, { chain: 'ethereum', address: OTHER, ownerAddressId: 1, source: 'safe' });
    upsertSuggestion(db, { chain: 'arbitrum', address: OTHER, ownerAddressId: 1, source: 'safe' });
    assert.deepEqual(
      getSuggestions(db).map((x) => x.chain),
      ['arbitrum'],
    );
  });
  test('accept adds the address to every wallet of the owner with all suggested chains', () => {
    const db = seed();
    upsertSuggestion(db, { chain: 'arbitrum', address: SAFE, ownerAddressId: 1, source: 'safe' });
    upsertSuggestion(db, { chain: 'ethereum', address: SAFE, ownerAddressId: 1, source: 'safe' });
    const id = getSuggestions(db)[0].id;
    const r = actOnSuggestion(db, id, 'accept');
    assert.ok(r && r.status === 'accepted' && r.addressId != null);
    assert.ok(r.jobIds.length > 0);
    const row = db.prepare('SELECT id, chains FROM addresses WHERE address = ?').get(SAFE) as { id: number; chains: string };
    assert.deepEqual(JSON.parse(row.chains).sort(), ['arbitrum', 'ethereum']);
    const wallets = (db.prepare('SELECT wallet_id FROM wallet_addresses WHERE address_id = ? ORDER BY wallet_id').all(row.id) as { wallet_id: number }[]).map((w) => w.wallet_id);
    assert.deepEqual(wallets, [1, 2]);
    assert.equal(getSuggestions(db).length, 0);
  });
  test('accepting for an address tracked on another chain adds the chain', () => {
    const db = seed();
    upsertSuggestion(db, { chain: 'arbitrum', address: OTHER, ownerAddressId: 2, source: 'safe' });
    const r = actOnSuggestion(db, getSuggestions(db)[0].id, 'accept');
    assert.equal(r?.addressId, 3);
    const row = db.prepare('SELECT chains FROM addresses WHERE id = 3').get() as { chains: string };
    assert.deepEqual(JSON.parse(row.chains), ['ethereum', 'arbitrum']);
  });
  test('a dismissed suggestion stays dismissed when discovery finds it again', () => {
    const db = seed();
    upsertSuggestion(db, { chain: 'ethereum', address: PROXY, ownerAddressId: 1, source: 'dsproxy' });
    const id = getSuggestions(db)[0].id;
    assert.equal(actOnSuggestion(db, id, 'dismiss')?.status, 'dismissed');
    assert.equal(upsertSuggestion(db, { chain: 'ethereum', address: PROXY, ownerAddressId: 1, source: 'dsproxy' }), false);
    assert.equal(getSuggestions(db).length, 0);
    assert.equal(actOnSuggestion(db, 999, 'accept'), null);
  });
});
