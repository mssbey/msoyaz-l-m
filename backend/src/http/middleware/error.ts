import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger.js';
import { WmsError } from '../../modules/wms/wms.service.js';
import { PricingError } from '../../modules/pricing/pricing.engine.js';

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Kaynak bulunamadi.' });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({ error: 'Dogrulama hatasi', details: err.flatten() });
  }

  if (err instanceof WmsError) {
    const status = err.code === 'BARCODE_NOT_FOUND' ? 404 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }

  if (err instanceof PricingError) {
    return res.status(409).json({ error: err.message, code: 'PRICING_ERROR' });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Bu kayit zaten mevcut (benzersizlik ihlali).', meta: err.meta });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Kayit bulunamadi.' });
    }
  }

  logger.error({ err }, 'Beklenmeyen hata');
  return res.status(500).json({ error: 'Sunucu hatasi.' });
}

/** async route handler'larda try/catch tekrarini onler. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as T, res, next).catch(next);
  };
}
