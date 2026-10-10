// One-shot hourly backfill (last 7 days, see lib/history/hourly.ts) plus a report of the 24h / 7d
// history series as /api/history would return them. Counts every outgoing request per host.
//
//   DATABASE_PATH=./data/hourly-test.db npx tsx scripts/hourly-backfill.ts
//   options: --address 0x...  --chains arbitrum,ethereum  --hours 168  --report-only
import { getHistory } from '../lib/queries/history';
import { scanFindAddressId } from '../lib/db/repos-scan';
import { runHourlyBackfill } from '../lib/history/hourly';
import { ETH_KEY } from '../lib/history/price-keys';
import type { HistoryChain } from '../lib/history/types';
import { databasePath, loadEnv, migrateDb, openDb } from '../lib/scan/env';
import { createLogger, errMsg } from '../lib/scan/log';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}

// Count requests per host (and JSON-RPC methods) by wrapping fetch.
const counts = new Map<string, number>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let key = new URL(url).host;
  if (typeof init?.body === 'string' && init.body.includes('"jsonrpc"')) {
    try {
      key += ` ${(JSON.parse(init.body) as { method?: string }).method}`;
    } catch {
      /* ignore */
    }
  } else if (key === 'coins.llama.fi') key += ` ${new URL(url).pathname.split('/')[1]}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return realFetch(input, init);
}) as typeof fetch;

const fmt = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, "'");
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');

async function main(): Promise<void> {
  loadEnv();
  const log = createLogger('hourly', { json: false });
  const db = openDb();
  await migrateDb(db, log);
  log.info(`database ${databasePath()}`);

  const address = arg('address');
  const addressId = address ? scanFindAddressId(db, address) : null;
  if (address && addressId == null) throw new Error(`address ${address} is not tracked in this database`);
  const chains = arg('chains')
    ?.split(',')
    .filter((c): c is HistoryChain => c === 'ethereum' || c === 'arbitrum');

  if (!process.argv.includes('--report-only')) {
    const t0 = Date.now();
    const r = await runHourlyBackfill({
      db,
      log,
      addressIds: addressId != null ? [addressId] : undefined,
      chains: chains?.length ? chains : undefined,
      hours: arg('hours') ? Number(arg('hours')) : undefined,
    });
    const rpc = [...counts].filter(([k]) => !k.startsWith('coins.llama.fi')).reduce((s, [, n]) => s + n, 0);
    console.log(`\nhourly backfill: ${((Date.now() - t0) / 1000).toFixed(1)}s, slices todo ${r.slicesTodo}, written ${r.slicesWritten}`);
    console.log(`chains: ${JSON.stringify(r.chains)}`);
    console.log(`requests: RPC ${rpc}, total ${[...counts.values()].reduce((s, n) => s + n, 0)}`);
    for (const [k, n] of [...counts].sort()) console.log(`  ${k.padEnd(48)} ${n}`);
  }

  const scope = address ? ({ kind: 'address', address } as const) : ({ kind: 'all' } as const);
  const eth = db.prepare("SELECT usd FROM prices WHERE price_key = ? AND granularity = 'hourly' AND ts = ?");
  for (const range of ['24h', '7d'] as const) {
    const h = getHistory(db, scope, range, 'protocol');
    if (!h) continue;
    const totals = h.points.map((p) => p.total);
    const kinds = db
      .prepare(
        `SELECT s.kind AS k, COUNT(DISTINCT s.id) AS n FROM snapshots s JOIN position_values pv ON pv.snapshot_id = s.id
         WHERE s.ts > ? AND s.ts <= ? GROUP BY s.kind`,
      )
      .all(h.from, h.to) as { k: string; n: number }[];
    console.log(
      `\n${range}: ${h.points.length} points, min $${fmt(Math.min(...totals))}, max $${fmt(Math.max(...totals))}, first ${iso(h.points[0]?.t ?? 0)}, last ${iso(h.points.at(-1)?.t ?? 0)}`,
    );
    console.log(`  snapshots in range: ${kinds.map((k) => `${k.k} ${k.n}`).join(', ')}`);
    const step = Math.max(1, Math.floor(h.points.length / 8));
    for (let i = 0; i < h.points.length; i += step) {
      const p = h.points[i];
      const e = (eth.get(ETH_KEY, p.t) as { usd: number } | undefined)?.usd;
      console.log(`  ${iso(p.t)}  total $${fmt(p.total).padStart(7)}  ${Object.entries(p.series).map(([k, v]) => `${k} $${fmt(v)}`).join('  ')}${e ? `  ETH $${e.toFixed(1)}` : ''}`);
    }
  }
  const hf = db
    .prepare(
      `SELECT s.ts AS ts, a.health_factor AS hf, a.collateral_usd AS c, a.debt_usd AS d FROM aave_accounts a JOIN snapshots s ON s.id = a.snapshot_id
       WHERE s.kind = 'hourly' ORDER BY s.ts DESC LIMIT 1`,
    )
    .get() as { ts: number; hf: number; c: number; d: number } | undefined;
  if (hf) console.log(`\nlatest hourly aave account ${iso(hf.ts)}: collateral $${fmt(hf.c)}, debt $${fmt(hf.d)}, HF ${hf.hf?.toFixed(3)}`);
  db.close();
}

main().catch((e) => {
  console.error(errMsg(e));
  process.exit(1);
});
