import { createHash } from 'node:crypto';
import type { Request } from 'express';
import IORedis from 'ioredis';
import { env } from '../../config/env.js';

// Authentication must fail promptly if Redis is unavailable.
export const authRedis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
export const COOKIE = 'mso_session';
export const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: env.NODE_ENV === 'production', path: '/api' };
export const credentialVersion = createHash('sha256').update(env.ADMIN_USERNAME + env.ADMIN_PASSWORD_HASH).digest('hex');
export const sessionKey = (token: string) => `${env.QUEUE_PREFIX}:auth:session:${createHash('sha256').update(token).digest('hex')}`;
export function sessionToken(req: Request) {
  const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export async function readSession(req: Request): Promise<{ username: string; role: 'ADMIN' } | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const raw = await authRedis.get(sessionKey(token));
  if (!raw) return null;
  const session = JSON.parse(raw);
  if (session.version !== credentialVersion) return null;
  return { username: session.username, role: 'ADMIN' };
}
