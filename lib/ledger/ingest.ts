// Transactions ledger ingestion (job 'ledger', history lane).
// Per (address, chain), incremental from ledger_state:
//   1. ERC20 Transfer (in / out) and Approval (owner) logs -> tx_transfers kind_hint erc20 / approval
//   2. native ETH via alchemy_getAssetTransfers -> kind_hint native, or call for zero value
//      external transactions (they reveal the sender of every transaction a tracked EOA sent)
//   3. tx rows (block, ts, sender when known) and tx_addresses for every TRACKED participant
// Then, for the whole chain: token amounts where decimals became known, USD at the day's price where
// a daily price exists (aTokens / debt tokens via the underlying key in tokens.price_key), and the gas
// fee of transactions sent by a tracked EOA (eth_getTransactionReceipt, capped per run), and the
// eth_getCode of every new counterparty (address_code: only EOAs make deposits / withdrawals).
// Finally the Arbitrum bridge legs of all tracked addresses are re-paired (bridge_pairs).
// Re-running over an overlapping range is idempotent (primary keys + ON CONFLICT DO NOTHING).
import { fetchTokenMeta } from '../history/aave';
import { ETH_KEY, canonicalPriceKey } from '../history/price-keys';
import { archiveRpc, toHex } from '../history/rpc';
import { DAY, NATIVE_TOKEN, dayStart, nowSec, throwIfAborted, type Db, type HistoryChain } from '../history/types';
import { scanListAddresses, SCAN_CHAINS, type ScanAddress } from '../db/repos-scan';
import { HEAD_LAG, headBlock, latestRpc } from '../scan/rpc-latest';
import { errMsg, type Logger } from '../scan/log';
import { rebuildBridgePairs } from './bridge';
import { APPROVAL_TOPIC, CallStats, TRANSFER_TOPIC, alchemyUrl, fetchLogs, fetchNative, type AlchemyTransfer, type RawLog } from './sources';

export interface RunLedgerOptions {
  db: Db;
  log: Logger;
  signal?: AbortSignal;
  addressIds?: number[];
  chains?: HistoryChain[];
  /** max eth_getTransactionReceipt calls per chain and run (gas fees), default 2000 */
  receiptBudget?: number;
  /** max eth_getCode calls per chain and run (counterparty EOA / contract), default 3000 */
  codeBudget?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface LedgerPairResult {
  addressId: number;
  chain: HistoryChain;
  logs: number;
  native: number | null;
  newTransfers: number;
  lastBlock: number | null;
  source: string;
  error?: string;
}

export interface RunLedgerResult {
  pairs: LedgerPairResult[];
  stats: CallStats;
  amountsFilled: number;
  pricesFilled: number;
  feesFetched: number;
  codesChecked: number;
  bridgePairs: number;
  durationMs: number;
}

interface TransferRow {
  chain: HistoryChain;
  hash: string;
  ref: string;
  token: string;
  from: string;
  to: string;
  raw: string;
  amount: number | null;
  kind: 'erc20' | 'native' | 'approval' | 'call';
  block: number;
  ts: number | null;
  sender: string | null;
}

const topicAddr = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();
const hexNum = (h: string | undefined | null): number => (h ? Number(BigInt(h)) : NaN);

function rawFromData(data: string | undefined): bigint {
  if (!data || data === '0x') return 0n;
  try {
    return BigInt(data.length > 66 ? data.slice(0, 66) : data);
  } catch {
    return 0n;
  }
}

export function unitsToFloat(raw: string, decimals: number): number {
  const v = BigInt(raw);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const n = Number(a / base) + Number(a % base) / Number(base);
  return neg ? -n : n;
}

function logToRow(chain: HistoryChain, l: RawLog): TransferRow | null {
  const t0 = l.topics[0]?.toLowerCase();
  if (t0 !== TRANSFER_TOPIC && t0 !== APPROVAL_TOPIC) return null;
  const raw = rawFromData(l.data);
  const ts = hexNum(l.blockTimestamp);
  return {
    chain,
    hash: l.transactionHash.toLowerCase(),
    ref: `log:${hexNum(l.logIndex)}`,
    token: l.address.toLowerCase(),
    from: topicAddr(l.topics[1]),
    to: topicAddr(l.topics[2]),
    raw: raw.toString(),
    amount: null,
    kind: t0 === TRANSFER_TOPIC ? 'erc20' : 'approval',
    block: hexNum(l.blockNumber),
    ts: Number.isFinite(ts) && ts > 0 ? ts : null,
    sender: null,
  };
}

function nativeToRow(chain: HistoryChain, t: AlchemyTransfer): TransferRow | null {
  if (!t.hash || !t.from) return null;
  const hash = t.hash.toLowerCase();
  const uid = t.uniqueId ?? '';
  const ref = uid.toLowerCase().startsWith(`${hash}:`) ? uid.slice(hash.length + 1) : `${t.category}:${uid}`;
  let raw = 0n;
  try {
    raw = t.rawContract?.value ? BigInt(t.rawContract.value) : BigInt(Math.round((t.value ?? 0) * 1e18));
  } catch {
    raw = 0n;
  }
  const ts = t.metadata?.blockTimestamp ? Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000) : NaN;
  return {
    chain,
    hash,
    ref,
    token: NATIVE_TOKEN,
    from: t.from.toLowerCase(),
    to: (t.to ?? NATIVE_TOKEN).toLowerCase(),
    raw: raw.toString(),
    amount: unitsToFloat(raw.toString(), 18),
    kind: raw === 0n ? 'call' : 'native',
    block: hexNum(t.blockNum),
    ts: Number.isFinite(ts) ? ts : null,
    sender: t.category === 'external' ? t.from.toLowerCase() : null,
  };
}

interface LedgerStateRow {
  last_block: number | null;
  native_block: number | null;
}

function getState(db: Db, addressId: number, chain: HistoryChain): LedgerStateRow | undefined {
  return db.prepare('SELECT last_block, native_block FROM ledger_state WHERE address_id = ? AND chain = ?').get(addressId, chain) as LedgerStateRow | undefined;
}

function addressExists(db: Db, id: number): boolean {
  return !!db.prepare('SELECT 1 FROM addresses WHERE id = ?').get(id);
}

/** Write one (address, chain) batch and advance the cursors, atomically. */
function writeBatch(
  db: Db,
  rows: TransferRow[],
  own: Map<string, number>,
  addressId: number,
  chain: HistoryChain,
  lastBlock: number | null,
  nativeBlock: number | null,
  error: string | null,
): number {
  const insTx = db.prepare(
    `INSERT INTO tx (chain, hash, block, ts, from_addr) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chain, hash) DO UPDATE SET from_addr = COALESCE(tx.from_addr, excluded.from_addr)`,
  );
  const insTr = db.prepare(
    `INSERT INTO tx_transfers (chain, hash, ref, token, from_addr, to_addr, amount_raw, amount, usd, kind_hint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?) ON CONFLICT(chain, hash, ref) DO NOTHING`,
  );
  const insAddr = db.prepare('INSERT INTO tx_addresses (address_id, chain, hash, ts) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING');
  let inserted = 0;
  db.transaction(() => {
    if (!addressExists(db, addressId)) return; // purged while the job ran
    for (const r of rows) {
      if (r.ts == null) continue;
      insTx.run(chain, r.hash, r.block, r.ts, r.sender);
      inserted += Number(insTr.run(chain, r.hash, r.ref, r.token, r.from, r.to, r.raw, r.amount, r.kind).changes);
      for (const a of [r.from, r.to]) {
        const id = own.get(a);
        if (id != null) insAddr.run(id, chain, r.hash, r.ts);
      }
    }
    db.prepare(
      `INSERT INTO ledger_state (address_id, chain, last_block, native_block, updated_at, error) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(address_id, chain) DO UPDATE SET last_block = COALESCE(excluded.last_block, ledger_state.last_block),
         native_block = COALESCE(excluded.native_block, ledger_state.native_block), updated_at = excluded.updated_at, error = excluded.error`,
    ).run(addressId, chain, lastBlock, nativeBlock, nowSec(), error);
  })();
  return inserted;
}

/** Block timestamps for rows whose source did not carry one (in-run cache, then known tx rows, then RPC). */
async function fillTimestamps(db: Db, chain: HistoryChain, rows: TransferRow[], cache: Map<number, number>, stats: CallStats, log: Logger, signal?: AbortSignal): Promise<void> {
  for (const r of rows) if (r.ts != null) cache.set(r.block, r.ts);
  const known = db.prepare('SELECT ts FROM tx WHERE chain = ? AND block = ? LIMIT 1');
  const rpc = archiveRpc(chain, log);
  for (const r of rows) {
    if (r.ts != null) continue;
    let ts = cache.get(r.block);
    if (ts == null) {
      const k = known.get(chain, r.block) as { ts: number } | undefined;
      ts = k?.ts;
    }
    if (ts == null) {
      throwIfAborted(signal);
      try {
        stats.rpc++;
        stats.blocks++;
        const b = await rpc.request<{ timestamp: string } | null>('eth_getBlockByNumber', [toHex(r.block), false], signal);
        if (b?.timestamp) ts = Number(BigInt(b.timestamp));
      } catch (e) {
        if (signal?.aborted) throw e;
        log.warn(`ledger ${chain}: block ${r.block} timestamp failed`, { error: errMsg(e) });
      }
    }
    if (ts != null) {
      cache.set(r.block, ts);
      r.ts = ts;
    }
  }
}

async function ledgerOne(
  db: Db,
  chain: HistoryChain,
  a: ScanAddress,
  head: number,
  own: Map<string, number>,
  tsCache: Map<number, number>,
  stats: CallStats,
  opts: RunLedgerOptions,
): Promise<LedgerPairResult> {
  const { log, signal } = opts;
  const st = getState(db, a.id, chain);
  const res: LedgerPairResult = { addressId: a.id, chain, logs: 0, native: null, newTransfers: 0, lastBlock: st?.last_block ?? null, source: '' };

  // first run: chunked fallback starts at the first activity found by discovery (full range starts at 0)
  const disc = db.prepare('SELECT start_block FROM discovery_state WHERE address_id = ? AND chain = ?').get(a.id, chain) as { start_block: number | null } | undefined;
  const logsFrom = (st?.last_block ?? -1) + 1;
  const lr = await fetchLogs(chain, a.address, logsFrom, head, log, stats, signal, 300, st?.last_block == null ? Math.max(0, (disc?.start_block ?? 0) - 1) : undefined);
  res.logs = lr.logs.length;
  res.source = lr.source;
  const rows: TransferRow[] = [];
  for (const l of lr.logs) {
    const r = logToRow(chain, l);
    if (r) rows.push(r);
  }

  let nativeBlock: number | null = null;
  let error: string | null = null;
  if (alchemyUrl(chain)) {
    const nativeFrom = (st?.native_block ?? -1) + 1;
    try {
      const nt = await fetchNative(chain, a.address, nativeFrom, head, log, stats, signal);
      if (nt) {
        res.native = nt.length;
        for (const t of nt) {
          const r = nativeToRow(chain, t);
          if (r) rows.push(r);
        }
        nativeBlock = head;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      error = `native transfers: ${errMsg(e)}`;
      log.warn(`ledger ${chain}: native transfers for ${a.address} failed, retried next run`, { error: errMsg(e) });
    }
  }

  await fillTimestamps(db, chain, rows, tsCache, stats, log, signal);
  const missingTs = rows.filter((r) => r.ts == null);
  // never advance past a block whose rows could not be stored
  const minMissing = missingTs.length ? Math.min(...missingTs.map((r) => r.block)) - 1 : Infinity;
  const lastBlock = lr.reached >= logsFrom ? Math.min(lr.reached, minMissing) : null;
  if (nativeBlock != null) nativeBlock = Math.min(nativeBlock, minMissing);
  res.newTransfers = writeBatch(db, rows, own, a.id, chain, lastBlock, nativeBlock, error);
  res.lastBlock = lastBlock ?? res.lastBlock;
  log.info(`ledger ${chain}: ${a.address} ${res.logs} logs, ${res.native ?? '-'} native, ${res.newTransfers} new`, {
    source: lr.source,
    lastBlock: res.lastBlock,
    reached: lr.reached,
    head,
  });
  if (lr.reached < head) log.info(`ledger ${chain}: ${a.address} logs scanned to ${lr.reached} of ${head}, will continue next run`);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Enrichment: amounts, USD, fees

interface TokenInfo {
  decimals: number | null;
  price_key: string | null;
  spam: number | null;
}

async function fillAmounts(db: Db, chain: HistoryChain, head: number, log: Logger, signal?: AbortSignal): Promise<number> {
  const rows = db
    .prepare(
      `SELECT tt.hash, tt.ref, tt.token, tt.amount_raw, t.decimals FROM tx_transfers tt
       LEFT JOIN tokens t ON t.chain = tt.chain AND t.address = tt.token
       WHERE tt.chain = ? AND tt.amount IS NULL AND tt.kind_hint = 'erc20'`,
    )
    .all(chain) as { hash: string; ref: string; token: string; amount_raw: string; decimals: number | null }[];
  if (!rows.length) return 0;
  const unknown = [...new Set(rows.filter((r) => r.decimals == null).map((r) => r.token))];
  let meta = new Map<string, { decimals: number | null }>();
  if (unknown.length) {
    try {
      meta = await fetchTokenMeta(latestRpc(chain, log), chain, head, unknown, signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      log.warn(`ledger ${chain}: token metadata for ${unknown.length} unknown tokens failed`, { error: errMsg(e) });
    }
  }
  const upd = db.prepare('UPDATE tx_transfers SET amount = ? WHERE chain = ? AND hash = ? AND ref = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const dec = r.decimals ?? meta.get(r.token)?.decimals ?? null;
      if (dec == null || dec < 0 || dec > 36) continue;
      try {
        upd.run(unitsToFloat(r.amount_raw, dec), chain, r.hash, r.ref);
        n++;
      } catch {
        /* malformed raw */
      }
    }
  })();
  return n;
}

class DailyPrices {
  private byKey = new Map<string, Map<number, number>>();
  private live = new Map<string, { ts: number; usd: number }>();
  constructor(private db: Db) {}
  load(keys: string[]): void {
    const need = keys.filter((k) => !this.byKey.has(k));
    if (!need.length) return;
    const q = this.db.prepare("SELECT ts, usd FROM prices WHERE price_key = ? AND granularity = 'daily'");
    const ql = this.db.prepare("SELECT ts, usd FROM prices WHERE price_key = ? AND granularity = 'live' ORDER BY ts DESC LIMIT 1");
    for (const k of need) {
      const m = new Map<number, number>();
      for (const r of q.all(k) as { ts: number; usd: number }[]) m.set(r.ts, r.usd);
      this.byKey.set(k, m);
      const l = ql.get(k) as { ts: number; usd: number } | undefined;
      if (l) this.live.set(k, l);
    }
  }
  /** Daily price of the tx day (or up to 3 days before / 1 after); recent txs fall back to the latest live price. */
  at(key: string, ts: number): number | null {
    this.load([key]);
    const m = this.byKey.get(key)!;
    const d = dayStart(ts);
    for (const off of [0, -1, 1, -2, -3]) {
      const v = m.get(d + off * DAY);
      if (v != null) return v;
    }
    const l = this.live.get(key);
    if (l && Math.abs(l.ts - ts) < 3 * DAY) return l.usd;
    return null;
  }
}

function fillUsd(db: Db, chain: HistoryChain): number {
  const rows = db
    .prepare(
      `SELECT tt.hash, tt.ref, tt.token, tt.amount, x.ts, t.price_key, t.spam FROM tx_transfers tt
       JOIN tx x ON x.chain = tt.chain AND x.hash = tt.hash
       LEFT JOIN tokens t ON t.chain = tt.chain AND t.address = tt.token
       WHERE tt.chain = ? AND tt.usd IS NULL AND tt.amount IS NOT NULL AND tt.kind_hint IN ('erc20', 'native')`,
    )
    .all(chain) as ({ hash: string; ref: string; token: string; amount: number; ts: number } & Omit<TokenInfo, 'decimals'>)[];
  const prices = new DailyPrices(db);
  const upd = db.prepare('UPDATE tx_transfers SET usd = ? WHERE chain = ? AND hash = ? AND ref = ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (r.spam) continue; // spam is never valued
      if (r.amount === 0) {
        upd.run(0, chain, r.hash, r.ref);
        n++;
        continue;
      }
      const key = r.token === NATIVE_TOKEN ? ETH_KEY : r.price_key ?? canonicalPriceKey(chain, r.token);
      const p = prices.at(key, r.ts);
      if (p == null) continue;
      upd.run(r.amount * p, chain, r.hash, r.ref);
      n++;
    }
    // fees already fetched but not valued yet
    const fees = db.prepare('SELECT hash, ts, fee_wei FROM tx WHERE chain = ? AND fee_wei IS NOT NULL AND fee_usd IS NULL').all(chain) as {
      hash: string;
      ts: number;
      fee_wei: string;
    }[];
    const updFee = db.prepare('UPDATE tx SET fee_usd = ? WHERE chain = ? AND hash = ?');
    for (const f of fees) {
      const p = prices.at(ETH_KEY, f.ts);
      if (p != null) updFee.run(unitsToFloat(f.fee_wei, 18) * p, chain, f.hash);
    }
  })();
  return n;
}

/** Gas fee (gasUsed x effectiveGasPrice) for transactions sent by a tracked EOA; capped per run. */
async function fillFees(db: Db, chain: HistoryChain, own: Map<string, number>, budget: number, stats: CallStats, log: Logger, signal?: AbortSignal): Promise<number> {
  const rows = db.prepare('SELECT hash, from_addr FROM tx WHERE chain = ? AND from_addr IS NOT NULL AND COALESCE(receipt, 0) = 0 ORDER BY ts DESC').all(chain) as {
    hash: string;
    from_addr: string;
  }[];
  const todo = rows.filter((r) => own.has(r.from_addr)).slice(0, budget);
  const skip = db.prepare('UPDATE tx SET receipt = 1 WHERE chain = ? AND hash = ? AND fee_wei IS NULL');
  db.transaction(() => {
    for (const r of rows) if (!own.has(r.from_addr)) skip.run(chain, r.hash); // sent by someone else: no fee for us
  })();
  const rpc = latestRpc(chain, log);
  const upd = db.prepare('UPDATE tx SET receipt = 1, fee_wei = ? WHERE chain = ? AND hash = ?');
  let n = 0;
  for (const r of todo) {
    throwIfAborted(signal);
    try {
      stats.rpc++;
      stats.receipts++;
      const rc = await rpc.request<{ gasUsed?: string; effectiveGasPrice?: string; from?: string } | null>('eth_getTransactionReceipt', [r.hash], signal, 4);
      if (!rc?.gasUsed || !rc.effectiveGasPrice) continue;
      const fee = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice);
      upd.run(fee.toString(), chain, r.hash);
      n++;
    } catch (e) {
      if (signal?.aborted) throw e;
      log.debug(`ledger ${chain}: receipt ${r.hash} failed`, { error: errMsg(e) });
    }
  }
  return n;
}

/** True for runtime code that makes an address a contract; EIP-7702 delegated EOAs (0xef0100 + address) stay EOAs. */
export function isContractCode(code: string | null | undefined): boolean {
  const c = (code ?? '0x').toLowerCase();
  if (c === '0x' || c === '0x0' || c === '') return false;
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return false;
  return true;
}

/** eth_getCode (latest) for counterparties of tracked value legs not checked yet; capped per run. */
async function fillCodes(db: Db, chain: HistoryChain, own: Map<string, number>, budget: number, stats: CallStats, log: Logger, signal?: AbortSignal): Promise<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT tt.from_addr, tt.to_addr FROM tx_transfers tt LEFT JOIN tokens t ON t.chain = tt.chain AND t.address = tt.token
       WHERE tt.chain = ? AND tt.kind_hint IN ('erc20', 'native') AND COALESCE(t.spam, 0) = 0`,
    )
    .all(chain) as { from_addr: string; to_addr: string }[];
  const known = new Set((db.prepare('SELECT address FROM address_code WHERE chain = ?').all(chain) as { address: string }[]).map((r) => r.address));
  const todo = new Set<string>();
  for (const r of rows) {
    const fromOwn = own.has(r.from_addr);
    if (fromOwn === own.has(r.to_addr)) continue;
    const other = fromOwn ? r.to_addr : r.from_addr;
    if (other !== NATIVE_TOKEN && !known.has(other)) todo.add(other);
  }
  const list = [...todo].slice(0, budget);
  if (!list.length) return 0;
  const rpc = latestRpc(chain, log);
  const ins = db.prepare('INSERT INTO address_code (chain, address, is_contract, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(chain, address) DO UPDATE SET is_contract = excluded.is_contract, checked_at = excluded.checked_at');
  let n = 0;
  for (const a of list) {
    throwIfAborted(signal);
    try {
      stats.rpc++;
      const code = await rpc.request<string>('eth_getCode', [a, 'latest'], signal, 4);
      ins.run(chain, a, isContractCode(code) ? 1 : 0, nowSec());
      n++;
    } catch (e) {
      if (signal?.aborted) throw e;
      log.debug(`ledger ${chain}: eth_getCode ${a} failed`, { error: errMsg(e) });
    }
  }
  if (todo.size > list.length) log.info(`ledger ${chain}: ${todo.size - list.length} counterparties left for the code check of the next run`);
  return n;
}

// ---------------------------------------------------------------------------------------------

export async function runLedger(opts: RunLedgerOptions): Promise<RunLedgerResult> {
  const t0 = Date.now();
  const { db, log, signal } = opts;
  const chains = opts.chains ?? SCAN_CHAINS;
  const all = scanListAddresses(db);
  const own = new Map(all.map((a) => [a.address.toLowerCase(), a.id]));
  const targets = opts.addressIds ? all.filter((a) => opts.addressIds!.includes(a.id)) : all;
  const result: RunLedgerResult = { pairs: [], stats: new CallStats(), amountsFilled: 0, pricesFilled: 0, feesFetched: 0, codesChecked: 0, bridgePairs: 0, durationMs: 0 };
  const total = targets.reduce((s, a) => s + chains.filter((c) => a.chains.includes(c)).length, 0);
  let done = 0;

  await Promise.all(
    chains.map(async (chain) => {
      const stats = new CallStats();
      const addrs = targets.filter((a) => a.chains.includes(chain));
      if (!addrs.length) return;
      let head: number;
      try {
        stats.rpc++;
        head = (await headBlock(latestRpc(chain, log), signal)) - HEAD_LAG[chain];
      } catch (e) {
        if (signal?.aborted) throw e;
        log.error(`ledger ${chain}: cannot read head block`, { error: errMsg(e) });
        return;
      }
      if (!alchemyUrl(chain)) log.warn(`ledger ${chain}: no Alchemy endpoint configured, native ETH transfers are skipped`);
      const tsCache = new Map<number, number>();
      for (const a of addrs) {
        throwIfAborted(signal);
        try {
          result.pairs.push(await ledgerOne(db, chain, a, head, own, tsCache, stats, opts));
        } catch (e) {
          if (signal?.aborted) throw e;
          log.error(`ledger ${chain}: ${a.address} failed`, { error: errMsg(e) });
          result.pairs.push({ addressId: a.id, chain, logs: 0, native: null, newTransfers: 0, lastBlock: null, source: '', error: errMsg(e) });
          try {
            db.prepare(
              `INSERT INTO ledger_state (address_id, chain, updated_at, error) VALUES (?, ?, ?, ?)
               ON CONFLICT(address_id, chain) DO UPDATE SET updated_at = excluded.updated_at, error = excluded.error`,
            ).run(a.id, chain, nowSec(), errMsg(e));
          } catch {
            /* best effort */
          }
        }
        opts.onProgress?.(++done, total);
      }
      try {
        result.amountsFilled += await fillAmounts(db, chain, head, log, signal);
        result.feesFetched += await fillFees(db, chain, own, opts.receiptBudget ?? 2000, stats, log, signal);
        result.pricesFilled += fillUsd(db, chain);
        result.codesChecked += await fillCodes(db, chain, own, opts.codeBudget ?? 3000, stats, log, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        log.warn(`ledger ${chain}: enrichment failed`, { error: errMsg(e) });
      }
      result.stats.add(stats);
    }),
  );
  try {
    result.bridgePairs = rebuildBridgePairs(db, new Set(own.keys()));
  } catch (e) {
    log.warn('ledger: bridge pairing failed', { error: errMsg(e) });
  }
  result.durationMs = Date.now() - t0;
  log.info(`ledger finished in ${(result.durationMs / 1000).toFixed(1)}s`, {
    pairs: result.pairs.length,
    newTransfers: result.pairs.reduce((s, p) => s + p.newTransfers, 0),
    codesChecked: result.codesChecked,
    bridgePairs: result.bridgePairs,
    calls: { ...result.stats },
  });
  return result;
}
