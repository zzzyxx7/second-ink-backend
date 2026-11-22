import { randomBytes, randomUUID, scrypt as rawScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import type { Store } from './db.js';
import { ApiError, requireThat } from './errors.js';

const scrypt = promisify(rawScrypt);
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export interface Principal { id: string; username: string }

export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [salt, key] = encoded.split(':');
  const actual = await scrypt(password, salt!, 64) as Buffer;
  const expected = Buffer.from(key!, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function requestToken(req: Request) {
  const authorization = req.get('authorization');
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7);
  const cookie = req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('second_ink_session='));
  return cookie?.slice('second_ink_session='.length);
}
export async function authenticate(db: Store, req: Request): Promise<Principal> {
  const token = requestToken(req);
  requireThat(token && token.length <= 128, 401, 'UNAUTHENTICATED', '请先登录');
  const row = await db.get(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`, [hash(token), now()]);
  requireThat(row, 401, 'UNAUTHENTICATED', '登录已过期，请重新登录');
  return { id: row.id, username: row.username };
}
export async function newSession(db: Store, userId: string, hours: number) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)', [hash(token), userId, expiresAt]);
  return { token, expiresAt };
}
export function duplicate(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|Duplicate entry/i.test(error.message);
}
export function rejectDuplicate(error: unknown): never {
  if (duplicate(error)) throw new ApiError(409, 'ALREADY_EXISTS', '该记录已存在');
  throw error;
}
