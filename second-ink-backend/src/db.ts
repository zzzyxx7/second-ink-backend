import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import mysql, { type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import type { Config } from './config.js';
import { schema } from './schema.js';
import { migrations } from './migrations.js';
import { createHash } from 'node:crypto';

const migrationQueues = new Map<string, Promise<unknown>>();

export type Row = Record<string, any>;
type Value = string | number | null;
export interface Query {
  all<T extends Row = Row>(sql: string, params?: Value[]): Promise<T[]>;
  get<T extends Row = Row>(sql: string, params?: Value[]): Promise<T | undefined>;
  run(sql: string, params?: Value[]): Promise<number>;
}
export class Store implements Query {
  private sqlite?: DatabaseSync;
  private pool?: mysql.Pool;
  private queue: Promise<unknown> = Promise.resolve();
  readonly dialect: 'mysql' | 'sqlite';
  constructor(private config: Config) { this.dialect = config.databaseUrl ? 'mysql' : 'sqlite'; }
  get lock() { return this.dialect === 'mysql' ? ' FOR UPDATE' : ''; }
  async open() {
    await mkdir(this.config.dataDir, { recursive: true });
    if (this.dialect === 'mysql') {
      this.pool = mysql.createPool({ uri: this.config.databaseUrl, connectionLimit: 6, charset: 'utf8mb4' });
    } else {
      this.sqlite = new DatabaseSync(path.join(this.config.dataDir, 'second-ink.sqlite'));
      this.sqlite.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    }
    try { await this.migrate(); } catch (error) { await this.close(); throw error; }
    return this;
  }
  private async migrate() {
    const apply = async (q: Query) => {
      // v1 statements are idempotent; existing application rows are never rewritten.
      for (const sql of schema) await q.run(sql);
      if (!await q.get('SELECT version FROM schema_migrations WHERE version=?',[1]))
        await q.run('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)',[1,new Date().toISOString()]);
      for (const migration of migrations) {
        if (await q.get('SELECT version FROM schema_migrations WHERE version=?',[migration.version])) continue;
        for (const sql of migration.statements) await q.run(sql);
        await migration.after?.(q);
        await q.run('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)',[migration.version,new Date().toISOString()]);
      }
    };
    if (this.pool) {
      const connection=await this.pool.getConnection();
      let lockName='';
      try {
        const q=this.executor(connection), database=await q.get('SELECT DATABASE() AS name');
        lockName='second-ink:'+createHash('sha256').update(String(database!.name)).digest('hex').slice(0,40);
        const acquired=await q.get('SELECT GET_LOCK(?,30) AS acquired',[lockName]);
        if (Number(acquired?.acquired)!==1) throw new Error('Database migration lock unavailable');
        // MySQL DDL auto-commits. Each step can be replayed after an interrupted migration.
        await apply(q);
      } finally { if(lockName)await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]); connection.release(); }
    } else {
      const key=path.resolve(this.config.dataDir);
      const previous=migrationQueues.get(key)||Promise.resolve();
      const result=previous.catch(()=>{}).then(()=>this.transaction(apply));
      migrationQueues.set(key,result.catch(()=>{}));
      await result;
    }
  }
  private executor(connection?: PoolConnection): Query {
    const all = async <T extends Row = Row>(sql: string, params: Value[] = []): Promise<T[]> => {
      if (connection) { const [rows] = await connection.execute<RowDataPacket[]>(sql, params); return rows as T[]; }
      return this.sqlite!.prepare(sql).all(...params as any[]) as T[];
    };
    return {
      all,
      get: async <T extends Row = Row>(sql: string, params: Value[] = []): Promise<T | undefined> => (await all<T>(sql, params))[0],
      run: async (sql, params = []) => {
        if (connection) { const [result] = await connection.execute<ResultSetHeader>(sql, params); return result.affectedRows; }
        return Number(this.sqlite!.prepare(sql).run(...params as any[]).changes);
      }
    };
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async use<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    if (!this.pool) return this.serialized(() => fn(this.executor()));
    const connection = await this.pool.getConnection();
    try { return await fn(this.executor(connection)); } finally { connection.release(); }
  }
  all<T extends Row = Row>(sql: string, params: Value[] = []) { return this.use(q => q.all<T>(sql, params)); }
  get<T extends Row = Row>(sql: string, params: Value[] = []) { return this.use(q => q.get<T>(sql, params)); }
  run(sql: string, params: Value[] = []) { return this.use(q => q.run(sql, params)); }
  async transaction<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    if (!this.pool) return this.serialized(async () => {
      this.sqlite!.exec('BEGIN IMMEDIATE');
      try { const result = await fn(this.executor()); this.sqlite!.exec('COMMIT'); return result; }
      catch (error) { this.sqlite!.exec('ROLLBACK'); throw error; }
    });
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn(this.executor(connection));
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.queue; this.sqlite?.close(); await this.pool?.end(); }
}
