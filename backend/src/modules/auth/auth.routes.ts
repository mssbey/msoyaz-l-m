import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { verifyPassword } from './password.js';
import { authRedis, COOKIE, cookieOptions, credentialVersion, readSession, sessionKey, sessionToken } from './session.js';

export const authRouter = Router();
authRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
authRouter.use((req, res, next) => {
  if (req.method !== 'GET' && req.header('x-mso-client') !== 'web') return res.status(403).json({ error: 'Geçersiz istek.' });
  next();
});
authRouter.post('/login', async (req, res, next) => {
  try {
    if (!env.ADMIN_PASSWORD_HASH) return res.status(503).json({ error: 'Giriş hesabı henüz kurulmamış. Sunucuda npm run auth:setup komutunu çalıştırın.' });
    const input = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(512) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Kullanıcı adı ve şifrenizi girin.' });
    const bucket = createHash('sha256').update(req.ip ?? 'unknown').digest('hex');
    const key = `${env.QUEUE_PREFIX}:auth:attempts:${bucket}`;
    const attempts = Number(await authRedis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n", 1, key));
    if (attempts > 10) {
      res.setHeader('Retry-After', Math.max(1, await authRedis.ttl(key)));
      return res.status(429).json({ error: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' });
    }
    const valid = await verifyPassword(input.data.password, env.ADMIN_PASSWORD_HASH);
    if (!valid || input.data.username !== env.ADMIN_USERNAME) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
    const previous = sessionToken(req);
    if (previous) await authRedis.del(sessionKey(previous));
    const token = randomBytes(32).toString('hex');
    await authRedis.set(sessionKey(token), JSON.stringify({ username: env.ADMIN_USERNAME, version: credentialVersion }), 'EX', env.SESSION_HOURS * 3600);
    await authRedis.del(key);
    res.cookie(COOKIE, token, { ...cookieOptions, maxAge: env.SESSION_HOURS * 3600000 });
    res.json({ user: { username: env.ADMIN_USERNAME, role: 'ADMIN' } });
  } catch (err) { next(err); }
});
authRouter.get('/me', async (req, res, next) => {
  try {
    const user = await readSession(req);
    if (!user) return res.status(401).json({ error: 'Lütfen giriş yapın.' });
    res.json({ user });
  } catch (err) { next(err); }
});
authRouter.post('/logout', async (req, res, next) => {
  try {
    const token = sessionToken(req);
    if (token) await authRedis.del(sessionKey(token));
    res.clearCookie(COOKIE, cookieOptions);
    res.status(204).end();
  } catch (err) { next(err); }
});
