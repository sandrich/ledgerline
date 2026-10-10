// ledgerline worker: long-running scheduler + job queue consumer.
//
//   npx tsx worker/index.ts
//
// - Polls the `jobs` table every WORKER_POLL_SECONDS (default 5) so UI sync requests start quickly.
// - Two lanes so a multi-hour backfill never blocks live snapshots:
//     scan lane:    snapshot, discovery, sync
//     history lane: hourly-backfill, backfill, price-history, rollup, ledger
// - Scheduler enqueues periodic jobs (intervals from env, last enqueue times persisted in `meta`).
// - Heartbeat in meta 'worker_heartbeat' (unix seconds) on every tick.
// - SIGINT / SIGTERM: abort running jobs (they go back to 'pending' and resume), close the DB.
import {
  scanClaimJob,
  scanEnqueueJob,
  scanFinishJob,
  scanGetMeta,
  scanPruneJobs,
  scanRequeueRunning,
  scanSetMeta,
  type JobRow,
} from '../lib/db/repos-scan';
import { addressesNeedingHourly } from '../lib/history/hourly';
import type { Db } from '../lib/history/types';
import { envInt, loadEnv, migrateDb, openDb, databasePath } from '../lib/scan/env';
import { HISTORY_LANE_TYPES, SCAN_LANE_TYPES, dispatchJob, normalizeJobType, type JobType } from '../lib/scan/jobs';
import { createLogger, errMsg, type Logger } from '../lib/scan/log';

loadEnv();
const log = createLogger('worker');

const nowSec = () => Math.floor(Date.now() / 1000);

interface Schedule {
  type: JobType;
  everySec: number;
}

function schedules(): Schedule[] {
  return [
    { type: 'snapshot', everySec: envInt('SNAPSHOT_INTERVAL_MINUTES', 15) * 60 },
    { type: 'discovery', everySec: envInt('DISCOVERY_INTERVAL_MINUTES', 60) * 60 },
    // Transactions ledger: incremental from ledger_state, same cadence as discovery (RPC heavy only
    // on an address's first run, which discovery enqueues itself).
    { type: 'ledger', everySec: envInt('LEDGER_INTERVAL_MINUTES', envInt('DISCOVERY_INTERVAL_MINUTES', 60)) * 60 },
    { type: 'price-history', everySec: envInt('PRICE_HISTORY_INTERVAL_HOURS', 6) * 3600 },
    { type: 'rollup', everySec: envInt('ROLLUP_INTERVAL_MINUTES', 60) * 60 },
    // Backfill is resumable: re-running picks up days that failed or new addresses missed by the API.
    { type: 'backfill', everySec: envInt('BACKFILL_INTERVAL_HOURS', 6) * 3600 },
    // Hourly history of the last 7 days (also checked at worker start, see main): gap repair for
    // hours without live data. Only enqueued when some address misses hours.
    { type: 'hourly-backfill', everySec: envInt('HOURLY_BACKFILL_INTERVAL_HOURS', 6) * 3600 },
  ];
}

const schedKey = (t: JobType) => `sched:${t}`;

function runScheduler(db: Db, log: Logger): void {
  const t = nowSec();
  for (const s of schedules()) {
    let last = Number(scanGetMeta(db, schedKey(s.type)) ?? NaN);
    if (!Number.isFinite(last) && s.type === 'snapshot') last = Number(scanGetMeta(db, 'last_snapshot_at') ?? NaN);
    if (Number.isFinite(last) && t - last < s.everySec) continue;
    if (s.type === 'hourly-backfill' && !addressesNeedingHourly(db).length) {
      scanSetMeta(db, schedKey(s.type), String(t));
      continue;
    }
    const id = scanEnqueueJob(db, s.type, {});
    scanSetMeta(db, schedKey(s.type), String(t));
    log.debug(`scheduled ${s.type} (job ${id})`);
  }
}

class Lane {
  private wake: (() => void) | null = null;
  current: JobRow | null = null;
  constructor(
    public name: string,
    private types: string[],
    private db: Db,
    private log: Logger,
    private signal: AbortSignal,
  ) {}

  poke(): void {
    this.wake?.();
  }

  private idle(ms: number): Promise<void> {
    const signal = this.signal;
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      this.wake = done;
      function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      }
    }).then(() => {
      this.wake = null;
    });
  }

  /** Record a job's final status; retried briefly so a transient SQLITE_BUSY cannot kill the lane. */
  private async finish(id: number, status: 'done' | 'failed' | 'pending', error?: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        scanFinishJob(this.db, id, status, error);
        return;
      } catch (e) {
        if (attempt >= 5) {
          this.log.error(`could not record job #${id} as ${status}, it is requeued on the next worker start`, { error: errMsg(e) });
          return;
        }
        this.log.warn(`recording job #${id} as ${status} failed, retrying`, { error: errMsg(e) });
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  async run(pollMs: number): Promise<void> {
    while (!this.signal.aborted) {
      // Nothing in the loop body may end run(): an unexpected error is logged and the lane idles.
      try {
        await this.step(pollMs);
      } catch (e) {
        this.log.error('lane error, idling before the next poll', { error: errMsg(e) });
        await this.idle(pollMs);
      }
    }
  }

  private async step(pollMs: number): Promise<void> {
    let job: JobRow | null = null;
    try {
      job = scanClaimJob(this.db, this.types);
    } catch (e) {
      this.log.error('claim failed', { error: errMsg(e) });
    }
    if (!job) {
      this.beat('');
      await this.idle(pollMs);
      return;
    }
    this.current = job;
    this.beat(`${job.type}#${job.id}`);
    const jlog = this.log.child(`${normalizeJobType(job.type) ?? job.type}#${job.id}`);
    const t0 = Date.now();
    jlog.info('job started', { payload: job.payload });
    try {
      const out = await dispatchJob({ db: this.db, log: jlog, signal: this.signal, job });
      await this.finish(job.id, 'done');
      jlog.info(`job done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, out && typeof out === 'object' ? { result: out } : undefined);
    } catch (e) {
      if (this.signal.aborted) {
        // Shutdown: leave it for the next worker start (jobs are resumable).
        await this.finish(job.id, 'pending', 'interrupted by shutdown');
        jlog.warn('job interrupted by shutdown, requeued');
      } else {
        await this.finish(job.id, 'failed', errMsg(e));
        jlog.error(`job failed after ${((Date.now() - t0) / 1000).toFixed(1)}s`, { error: errMsg(e) });
      }
    } finally {
      this.current = null;
      this.beat('');
    }
  }

  /** Per-lane heartbeat (meta worker_lane_<name>_heartbeat / _job); best effort. */
  private beat(job: string): void {
    try {
      scanSetMeta(this.db, `worker_lane_${this.name}_heartbeat`, String(nowSec()));
      scanSetMeta(this.db, `worker_lane_${this.name}_job`, job);
    } catch {
      /* heartbeat is best effort */
    }
  }
}

async function main(): Promise<void> {
  const dbFile = databasePath();
  const db = openDb(dbFile);
  await migrateDb(db, log);
  const requeued = scanRequeueRunning(db);
  log.info('worker starting', {
    db: dbFile,
    pid: process.pid,
    requeued,
    intervals: Object.fromEntries(schedules().map((s) => [s.type, `${s.everySec}s`])),
  });
  scanSetMeta(db, 'worker_started_at', String(nowSec()));
  // Existing addresses (and hours missed while the worker was down) get the hourly backfill once.
  try {
    const need = addressesNeedingHourly(db);
    if (need.length) {
      const id = scanEnqueueJob(db, 'hourly-backfill', {});
      scanSetMeta(db, schedKey('hourly-backfill'), String(nowSec()));
      log.info(`enqueued hourly backfill job ${id} for ${need.length} address(es) missing recent hours`);
    }
  } catch (e) {
    log.warn('hourly backfill check failed', { error: errMsg(e) });
  }
  scanSetMeta(db, 'worker_heartbeat', String(nowSec()));

  const ctrl = new AbortController();
  const pollMs = envInt('WORKER_POLL_SECONDS', 5) * 1000;
  const lanes = [
    new Lane('scan', SCAN_LANE_TYPES, db, log.child('scan'), ctrl.signal),
    new Lane('history', HISTORY_LANE_TYPES, db, log.child('history'), ctrl.signal),
  ];

  // Unknown job types would sit in 'pending' forever: fail them loudly once.
  const known = new Set([...SCAN_LANE_TYPES, ...HISTORY_LANE_TYPES]);
  const failUnknown = () => {
    const rows = db.prepare("SELECT id, type FROM jobs WHERE status = 'pending'").all() as { id: number; type: string }[];
    for (const r of rows) {
      if (!known.has(r.type)) {
        scanFinishJob(db, r.id, 'failed', `unknown job type '${r.type}'`);
        log.warn(`failed unknown job type '${r.type}' (#${r.id})`);
      }
    }
  };

  let lastPrune = 0;
  const tick = () => {
    try {
      scanSetMeta(db, 'worker_heartbeat', String(nowSec()));
      runScheduler(db, log);
      failUnknown();
      if (Date.now() - lastPrune > 6 * 3600_000) {
        lastPrune = Date.now();
        const n = scanPruneJobs(db, envInt('JOBS_RETENTION_DAYS', 7));
        if (n) log.info(`pruned ${n} finished jobs`);
      }
      for (const l of lanes) l.poke();
    } catch (e) {
      log.error('tick failed', { error: errMsg(e) });
    }
  };
  tick();
  const timer = setInterval(tick, pollMs);

  const running = lanes.map((l) => l.run(pollMs));

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) {
      log.warn(`second ${sig}, exiting now`);
      process.exit(1);
    }
    stopping = true;
    log.info(`received ${sig}, shutting down`, { running: lanes.filter((l) => l.current).map((l) => `${l.name}:${l.current!.type}#${l.current!.id}`) });
    clearInterval(timer);
    ctrl.abort();
    const force = setTimeout(() => {
      log.warn('shutdown timeout, forcing exit');
      for (const l of lanes) if (l.current) scanFinishJob(db, l.current.id, 'pending', 'interrupted by shutdown');
      try {
        db.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }, envInt('WORKER_SHUTDOWN_TIMEOUT_SECONDS', 20) * 1000);
    force.unref();
    await Promise.allSettled(running);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    log.info('worker stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { error: errMsg(e) }));
  process.on('uncaughtException', (e) => log.error('uncaught exception', { error: errMsg(e), stack: e.stack?.split('\n').slice(0, 5).join(' | ') }));
}

main().catch((e) => {
  log.error('worker crashed during startup', { error: errMsg(e) });
  process.exit(1);
});
