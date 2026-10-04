import { config } from './config.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 } as const;
export type Level = keyof typeof LEVELS;

const COLORS: Record<string, string> = {
  trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m',
  warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m', dim: '\x1b[2m',
};

function redact(v: unknown, keys: readonly string[]): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, keys));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = keys.some((rk) => rk.trim().toLowerCase() === k.toLowerCase()) ? '[redacted]' : redact(val, keys);
  }
  return out;
}

export interface Logger {
  level: Level;
  child(bindings: Record<string, unknown>): Logger;
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

function make(bindings: Record<string, unknown>): Logger {
  const threshold = LEVELS[config.log.level] ?? LEVELS.info;

  const emit = (level: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[level] < threshold) return;
    const payload = { ...bindings, ...(meta ?? {}) };
    const safe = redact(payload, config.log.redactKeys) as Record<string, unknown>;
    if (config.log.pretty && !config.isProd) {
      const c = COLORS[level] ?? '';
      const extra = Object.keys(safe).length ? ` ${COLORS.dim}${JSON.stringify(safe)}${COLORS.reset}` : '';
      process.stdout.write(`${c}${level.toUpperCase().padEnd(5)}${COLORS.reset} ${msg}${extra}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...safe })}\n`);
    }
  };

  return {
    level: config.log.level,
    child: (b) => make({ ...bindings, ...b }),
    trace: (m, x) => emit('trace', m, x),
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}

export const logger = make({});
