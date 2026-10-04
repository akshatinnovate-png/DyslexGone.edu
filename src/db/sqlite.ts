import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { MIGRATIONS } from './schema.js';

export type Row = Record<string, unknown>;
export type Params = Record<string, unknown> | unknown[];

/** Thin, synchronous SQLite facade with JSON helpers and transactions.
 *  node:sqlite means zero native build steps - the whole OS runs from a single file. */
export class Db {
  readonly raw: DatabaseSync;
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    if (config.db.walMode && file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec(`PRAGMA busy_timeout = ${config.db.busyTimeoutMs};`);
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  private prep(sql: string) {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private static norm(params?: Params): unknown[] {
    if (params === undefined) return [];
    if (Array.isArray(params)) return params.map(Db.coerce);
    // named params -> node:sqlite accepts an object as a single arg
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) obj[k] = Db.coerce(v);
    return [obj];
  }

  private static coerce(v: unknown): unknown {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object' && !(v instanceof Uint8Array)) return JSON.stringify(v);
    return v;
  }

  exec(sql: string): void { this.raw.exec(sql); }

  run(sql: string, params?: Params): { changes: number; lastInsertRowid: number } {
    const r = this.prep(sql).run(...(Db.norm(params) as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  all<T extends Row = Row>(sql: string, params?: Params): T[] {
    return this.prep(sql).all(...(Db.norm(params) as never[])) as T[];
  }

  one<T extends Row = Row>(sql: string, params?: Params): T | undefined {
    return this.prep(sql).get(...(Db.norm(params) as never[])) as T | undefined;
  }

  scalar<T = number>(sql: string, params?: Params): T | undefined {
    const row = this.one(sql, params);
    if (!row) return undefined;
    return Object.values(row)[0] as T;
  }

  count(sql: string, params?: Params): number {
    return Number(this.scalar<number>(sql, params) ?? 0);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  /** Upsert helper: builds the INSERT ... ON CONFLICT statement from an object. */
  upsert(table: string, keys: string[], values: Row): void {
    const cols = Object.keys(values);
    const placeholders = cols.map(() => '?').join(',');
    const updates = cols.filter((c) => !keys.includes(c)).map((c) => `${c}=excluded.${c}`).join(',');
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})` +
      (updates ? ` ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${updates}` : ' ON CONFLICT DO NOTHING');
    this.run(sql, cols.map((c) => values[c]));
  }

  insert(table: string, values: Row): void {
    const cols = Object.keys(values);
    this.run(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map((c) => values[c]),
    );
  }

  migrate(): { applied: number[]; version: number } {
    this.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT, at TEXT)');
    const done = new Set(this.all<{ version: number }>('SELECT version FROM _migrations').map((r) => Number(r.version)));
    const applied: number[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        this.raw.exec(m.sql);
        this.run('INSERT INTO _migrations (version, name, at) VALUES (?,?,?)', [m.version, m.name, new Date().toISOString()]);
        this.raw.exec('COMMIT');
        applied.push(m.version);
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw new Error(`migration ${m.version} (${m.name}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const version = Number(this.scalar<number>('SELECT COALESCE(MAX(version),0) FROM _migrations') ?? 0);
    if (applied.length) logger.info('database migrated', { applied, version });
    return { applied, version };
  }

  tables(): string[] {
    return this.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((r) => r.name);
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const t of this.tables()) out[t] = this.count(`SELECT COUNT(*) FROM ${t}`);
    return out;
  }

  close(): void {
    this.stmtCache.clear();
    try { this.raw.close(); } catch { /* already closed */ }
  }
}

/* -------------------------- JSON column helpers --------------------------- */

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    const p = JSON.parse(value);
    return (p ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
export const numOr = (v: unknown, d = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
export const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v));

let instance: Db | null = null;

export function getDb(): Db {
  if (!instance) {
    instance = new Db(config.db.file);
    instance.migrate();
  }
  return instance;
}

/** For tests: an isolated in-memory database with the schema applied. */
export function memoryDb(): Db {
  const db = new Db(':memory:');
  db.migrate();
  return db;
}

export function setDb(db: Db): void { instance = db; }
export function closeDb(): void { instance?.close(); instance = null; }
