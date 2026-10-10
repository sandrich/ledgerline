// Read side of the transactions ledger, shared by lib/queries/transactions.ts and flows.ts.
// Works on the minimal QDb interface (better-sqlite3 at runtime, node:sqlite in tests).
import type { Chain, TxKind, TxRow } from '../queries/api-types';
import { all, get, jsonIds, type QDb } from '../queries/db';
import { classifyTx, type ClassifyContext, type CurveRole, type LegHint, type LegInput, type OwnInfo } from './classify';

const EXPLORER: Record<Chain, string> = {
  ethereum: 'https://etherscan.io/tx/',
  arbitrum: 'https://arbiscan.io/tx/',
};

export function ledgerTablesExist(db: QDb): boolean {
  return tableExists(db, 'tx_addresses');
}

function tableExists(db: QDb, name: string): boolean {
  return !!get<{ n: string }>(db, "SELECT name AS n FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

export interface LedgerScope {
  addressIds: number[];
  scope: Set<string>;
  own: Map<string, OwnInfo>;
  aTokens: Record<Chain, Set<string>>;
  /** Curve crvUSD / LlamaLend controllers, AMMs and vaults per chain (empty before migration 6) */
  curve: Record<Chain, Map<string, CurveRole>>;
}

/** Scope addresses, every tracked address with its display label, Aave aToken contracts per chain. */
export function loadScope(db: QDb, addressIds: number[]): LedgerScope {
  const addrs = all<{ id: number; address: string; label: string | null }>(db, 'SELECT id, address, label FROM addresses');
  const wallets = all<{ address_id: number; name: string }>(
    db,
    'SELECT wa.address_id, w.name FROM wallet_addresses wa JOIN wallets w ON w.id = wa.wallet_id ORDER BY w.sort, w.id',
  );
  const walletName = new Map<number, string>();
  for (const w of wallets) if (!walletName.has(w.address_id)) walletName.set(w.address_id, w.name);
  const own = new Map<string, OwnInfo>();
  const ids = new Set(addressIds);
  const scope = new Set<string>();
  for (const a of addrs) {
    const addr = a.address.toLowerCase();
    own.set(addr, { id: a.id, label: a.label?.trim() || walletName.get(a.id) || null });
    if (ids.has(a.id)) scope.add(addr);
  }
  const aTokens: Record<Chain, Set<string>> = { ethereum: new Set(), arbitrum: new Set() };
  for (const t of all<{ chain: string; address: string }>(db, "SELECT chain, address FROM tokens WHERE kind = 'atoken'")) {
    if (t.chain === 'ethereum' || t.chain === 'arbitrum') aTokens[t.chain].add(t.address.toLowerCase());
  }
  const curve: Record<Chain, Map<string, CurveRole>> = { ethereum: new Map(), arbitrum: new Map() };
  if (tableExists(db, 'curve_markets')) {
    for (const m of all<{ chain: string; controller: string; amm: string; vault: string | null; borrowed: string }>(
      db,
      'SELECT chain, controller, amm, vault, borrowed FROM curve_markets',
    )) {
      if (m.chain !== 'ethereum' && m.chain !== 'arbitrum') continue;
      const borrowed = m.borrowed.toLowerCase();
      const c = curve[m.chain];
      c.set(m.controller.toLowerCase(), { role: 'controller', borrowed });
      c.set(m.amm.toLowerCase(), { role: 'amm', borrowed });
      if (m.vault) c.set(m.vault.toLowerCase(), { role: 'vault', borrowed });
    }
  }
  return { addressIds, scope, own, aTokens, curve };
}

export interface RawTx {
  chain: Chain;
  hash: string;
  ts: number;
}

interface TxMeta {
  hash: string;
  block: number;
  from_addr: string | null;
  fee_usd: number | null;
}

interface LegRow {
  hash: string;
  ref: string;
  token: string;
  from_addr: string;
  to_addr: string;
  amount_raw: string | null;
  amount: number | null;
  usd: number | null;
  kind_hint: string;
  t_kind: string | null;
  spam: number | null;
  symbol: string | null;
  logo: string | null;
  price_key: string | null;
}

/** Classify a batch of transactions for a scope; result in input order. */
export function buildRows(db: QDb, s: LedgerScope, txs: RawTx[]): TxRow[] {
  const byChain = new Map<Chain, string[]>();
  for (const t of txs) {
    if (!byChain.has(t.chain)) byChain.set(t.chain, []);
    byChain.get(t.chain)!.push(t.hash);
  }
  const legs = new Map<string, LegInput[]>();
  const meta = new Map<string, TxMeta>();
  const involved = new Map<string, number[]>();
  const codes = new Map<Chain, Map<string, boolean>>();
  // FRONTEND: direction of paired bridge legs per tx, for the "Bridge Ethereum -> Arbitrum" label
  const bridges = new Map<string, { from: Chain; to: Chain }>();
  const hasCodes = tableExists(db, 'address_code');
  const hasPairs = tableExists(db, 'bridge_pairs');
  for (const [chain, hashes] of byChain) {
    const hj = JSON.stringify(hashes);
    // paired bridge legs: the bridge contract side becomes the tracked address on the other chain
    const peers = new Map<string, { own: string; peer: string }>();
    if (hasPairs) {
      const sql =
        chain === 'ethereum'
          ? 'SELECT l1_hash AS hash, l1_ref AS ref, l1_addr AS own, l2_addr AS peer FROM bridge_pairs WHERE l1_hash IN (SELECT value FROM json_each(?))'
          : 'SELECT l2_hash AS hash, l2_ref AS ref, l2_addr AS own, l1_addr AS peer FROM bridge_pairs WHERE l2_hash IN (SELECT value FROM json_each(?))';
      for (const p of all<{ hash: string; ref: string; own: string; peer: string }>(db, sql, hj)) peers.set(`${p.hash}:${p.ref}`, p);
    }
    for (const r of all<LegRow>(
      db,
      `SELECT tt.hash, tt.ref, tt.token, tt.from_addr, tt.to_addr, tt.amount_raw, tt.amount, tt.usd, tt.kind_hint,
              t.kind AS t_kind, t.spam, t.symbol, t.logo, t.price_key
       FROM tx_transfers tt LEFT JOIN tokens t ON t.chain = tt.chain AND t.address = tt.token
       WHERE tt.chain = ? AND tt.hash IN (SELECT value FROM json_each(?)) ORDER BY tt.hash, tt.ref`,
      chain,
      hj,
    )) {
      const k = `${chain}:${r.hash}`;
      if (!legs.has(k)) legs.set(k, []);
      let from = r.from_addr;
      let to = r.to_addr;
      const pair = peers.get(`${r.hash}:${r.ref}`);
      if (pair) {
        const outbound = from === pair.own;
        if (outbound) to = pair.peer;
        else from = pair.peer;
        // L1 side: own address sends = deposit to L2; L2 side: own address sends = withdrawal to L1
        const deposit = chain === 'ethereum' ? outbound : !outbound;
        bridges.set(k, deposit ? { from: 'ethereum', to: 'arbitrum' } : { from: 'arbitrum', to: 'ethereum' });
      }
      legs.get(k)!.push({
        ref: r.ref,
        token: r.token,
        from,
        to,
        amountRaw: r.amount_raw,
        amount: r.amount,
        usd: r.usd,
        hint: r.kind_hint as LegHint,
        tokenKind: r.t_kind,
        spam: !!r.spam,
        symbol: r.symbol,
        logo: r.logo,
        priceKey: r.price_key,
      });
    }
    if (hasCodes) {
      const addrs = new Set<string>();
      for (const h of hashes) for (const l of legs.get(`${chain}:${h}`) ?? []) addrs.add(s.scope.has(l.from) ? l.to : l.from);
      const m = new Map<string, boolean>();
      for (const c of all<{ address: string; is_contract: number }>(
        db,
        'SELECT address, is_contract FROM address_code WHERE chain = ? AND address IN (SELECT value FROM json_each(?))',
        chain,
        JSON.stringify([...addrs]),
      )) {
        m.set(c.address, !!c.is_contract);
      }
      codes.set(chain, m);
    }
    for (const m of all<TxMeta>(db, 'SELECT hash, block, from_addr, fee_usd FROM tx WHERE chain = ? AND hash IN (SELECT value FROM json_each(?))', chain, hj)) {
      meta.set(`${chain}:${m.hash}`, m);
    }
    for (const r of all<{ hash: string; address_id: number }>(
      db,
      `SELECT hash, address_id FROM tx_addresses WHERE chain = ? AND hash IN (SELECT value FROM json_each(?))
       AND address_id IN (SELECT value FROM json_each(?)) ORDER BY address_id`,
      chain,
      hj,
      jsonIds(s.addressIds),
    )) {
      const k = `${chain}:${r.hash}`;
      if (!involved.has(k)) involved.set(k, []);
      involved.get(k)!.push(r.address_id);
    }
  }
  return txs.map((t) => {
    const k = `${t.chain}:${t.hash}`;
    const ctx: ClassifyContext = { chain: t.chain, scope: s.scope, own: s.own, aTokens: s.aTokens[t.chain], codes: codes.get(t.chain), curve: s.curve[t.chain] };
    const m = meta.get(k);
    const c = classifyTx(legs.get(k) ?? [], ctx, m?.from_addr ?? null);
    return {
      id: k,
      chain: t.chain,
      hash: t.hash,
      ts: t.ts,
      block: m?.block ?? 0,
      kind: c.kind,
      addressIds: involved.get(k) ?? [],
      transfers: c.transfers,
      counterparty: c.counterparty,
      counterpartyLabel: c.counterpartyLabel,
      netUsd: c.netUsd,
      feeUsd: m?.from_addr && s.scope.has(m.from_addr) ? m.fee_usd ?? null : null,
      explorerUrl: `${EXPLORER[t.chain]}${t.hash}`,
      ...(bridges.has(k) ? { bridge: bridges.get(k) } : {}),
    };
  });
}

/** Distinct transactions of the scope, newest first, strictly after (older than) the cursor key. */
export function scopeTxPage(db: QDb, addressIds: number[], opts: { chain?: Chain; before?: { ts: number; hash: string; chain: string } | null; limit: number }): RawTx[] {
  const where: string[] = ['address_id IN (SELECT value FROM json_each(?))'];
  const params: unknown[] = [jsonIds(addressIds)];
  if (opts.chain) {
    where.push('chain = ?');
    params.push(opts.chain);
  }
  let having = '';
  const hp: unknown[] = [];
  if (opts.before) {
    having = 'HAVING (ts, hash, chain) < (?, ?, ?)';
    hp.push(opts.before.ts, opts.before.hash, opts.before.chain);
  }
  return all<RawTx>(
    db,
    `SELECT chain, hash, MAX(ts) AS ts FROM tx_addresses WHERE ${where.join(' AND ')}
     GROUP BY chain, hash ${having} ORDER BY ts DESC, hash DESC, chain DESC LIMIT ?`,
    ...params,
    ...hp,
    opts.limit,
  );
}

/** Kinds that never count as deposits / withdrawals ('other' is a protocol interaction or nets to zero). */
export const NON_FLOW_KINDS: ReadonlySet<TxKind> = new Set<TxKind>([
  'internal',
  'aave-supply',
  'aave-withdraw',
  'aave-borrow',
  'aave-repay',
  'curve-borrow',
  'curve-repay',
  'curve-deposit',
  'curve-withdraw',
  'swap',
  'spam',
  'approval',
  'other',
]);
