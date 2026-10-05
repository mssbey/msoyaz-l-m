import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env.js';
import { readSession } from '../../modules/auth/session.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      role?: 'ADMIN' | 'TERMINAL';
      operator?: string;
    }
  }
}

/** Session authentication for the web app; API keys remain available for integrations.
 * Session operators are always derived from the authenticated account.
 */
export function apiKeyAuth(required: 'ADMIN' | 'TERMINAL' | 'ANY' = 'ADMIN') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await readSession(req);
      if (session) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.header('x-mso-client') !== 'web') {
          return res.status(403).json({ error: 'Geçersiz istek.' });
        }
        req.role = session.role;
        req.operator = session.username;
        res.setHeader('Cache-Control', 'no-store');
        return next();
      }
      const key = req.header('x-api-key');
      if (!key) return res.status(401).json({ error: 'Oturumunuz sona erdi. Lütfen giriş yapın.' });

      let role: 'ADMIN' | 'TERMINAL' | undefined;
      if (key === env.ADMIN_API_KEY) role = 'ADMIN';
      else if (key === env.TERMINAL_API_KEY) role = 'TERMINAL';

      if (!role) return res.status(401).json({ error: 'Gecersiz API anahtari.' });

      // ADMIN her yere erisebilir; TERMINAL sadece kendi uclarina.
      if (required !== 'ANY' && role !== 'ADMIN' && role !== required) {
        return res.status(403).json({ error: 'Bu islem icin yetkiniz yok.' });
      }

      req.role = role;
      req.operator = req.header('x-operator') ?? undefined;
      next();
    } catch (err) { next(err); }
  };
}
