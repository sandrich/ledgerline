// Structured logger for the worker and scan scripts.
// JSON lines when stdout is not a TTY (systemd / journald) or LOG_FORMAT=json, compact text otherwise.
// Satisfies the HistoryLogger shape used by lib/history (debug?/info/warn/error with optional data).
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
}

function levelFromEnv(): LogLevel {
  const v = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return v === 'debug' || v === 'warn' || v === 'error' ? v : 'info';
}

/** Strip API keys from anything that looks like an RPC URL before it reaches the log. */
export function redactSecrets(s: string): string {
  return s
    .replace(/(https?:\/\/[^/\s"']+\/v\d+\/)[A-Za-z0-9_-]{8,}/g, '$1***')
    .replace(/([?&](?:apikey|api_key|key|token)=)[^&\s"']+/gi, '$1***');
}

function safeData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) out[k] = redactSecrets(v.message);
    else if (typeof v === 'string') out[k] = redactSecrets(v);
    else if (typeof v === 'bigint') out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

export function createLogger(scope = 'worker', opts: { level?: LogLevel; json?: boolean } = {}): Logger {
  const min = ORDER[opts.level ?? levelFromEnv()];
  const json = opts.json ?? (process.env.LOG_FORMAT === 'json' || (process.env.LOG_FORMAT !== 'text' && !process.stdout.isTTY));

  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const d = safeData(data);
    const m = redactSecrets(msg);
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    if (json) {
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, scope, msg: m, ...(d ?? {}) }, bigintSafe)}\n`);
    } else {
      const t = new Date().toISOString().slice(11, 19);
      const extra = d && Object.keys(d).length ? ` ${JSON.stringify(d, bigintSafe)}` : '';
      stream.write(`${t} ${level.toUpperCase().padEnd(5)} [${scope}] ${m}${extra}\n`);
    }
  };

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (s) => createLogger(`${scope}:${s}`, { level: (Object.keys(ORDER) as LogLevel[]).find((k) => ORDER[k] === min), json }),
  };
}

function bigintSafe(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

export function errMsg(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 500);
}
