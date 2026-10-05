import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/middleware/error.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueProductStockFlush, enqueueProductSync } from '../../queues/producers.js';
import { updateSettings } from '../settings/settings.service.js';
import {
  findProductsWithPendingStock,
  getWarehouses,
  resetFailedStockPushes,
  sentosStatus,
} from './sentos-sync.service.js';
import { ingestOrderWebhook, verifyWebhookSignature } from './sentos.service.js';

export const sentosWebhookRouter = Router();

/**
 * Sentos "Yeni Siparis" webhook ucu.
 * Kimlik dogrulamasi API anahtari ile degil, HMAC imzasi ile yapilir;
 * bu yuzden auth middleware'i disinda tutulur.
 */
sentosWebhookRouter.post(
  '/orders',
  asyncHandler(async (req, res) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
    const signature = req.header('x-sentos-signature') ?? req.header('x-signature');

    if (!verifyWebhookSignature(rawBody, signature ?? undefined)) {
      logger.warn({ signature }, 'Webhook imza dogrulamasi basarisiz');
      return res.status(401).json({ error: 'Gecersiz imza.' });
    }

    // Islem kuyruga birakilir; Sentos'a hemen 202 donulur (timeout olmamasi icin).
    const result = await ingestOrderWebhook(req.body);
    return res.status(202).json(result);
  }),
);

export const sentosAdminRouter = Router();

sentosAdminRouter.get(
  '/logs',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const items = await prisma.sentosSyncLog.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    res.json({ items });
  }),
);

sentosAdminRouter.get(
  '/webhooks',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const items = await prisma.webhookEvent.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
    res.json({ items });
  }),
);

/** Entegrasyon durumu: baglanti modu, son urun senkronu, bekleyen/hatali stok aktarimlari. */
sentosAdminRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json(await sentosStatus());
  }),
);

/** Sentos'tan tum urun + stoklari simdi cek. `/stock-check` eski adla uyumluluk icindir. */
for (const path of ['/sync-products', '/stock-check']) {
  sentosAdminRouter.post(
    path,
    asyncHandler(async (_req, res) => {
      const job = await enqueueProductSync('manual');
      res.status(202).json({ queued: true, jobId: job.id });
    }),
  );
}

sentosAdminRouter.get(
  '/warehouses',
  asyncHandler(async (req, res) => {
    try {
      res.json({ items: await getWarehouses(req.query.refresh === 'true') });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  }),
);

/** Okutmada stogun once dusulecegi depo. */
sentosAdminRouter.put(
  '/warehouse',
  asyncHandler(async (req, res) => {
    const { warehouseId } = z.object({ warehouseId: z.number().int().positive().nullable() }).parse(req.body);
    const { settings } = await updateSettings({ sentosWarehouseId: warehouseId });
    res.json({ warehouseId: settings.sentosWarehouseId });
  }),
);

/** Hatali stok aktarimlarini tekrar dene. */
sentosAdminRouter.post(
  '/retry-stock',
  asyncHandler(async (_req, res) => {
    const reset = await resetFailedStockPushes();
    const productIds = await findProductsWithPendingStock();
    for (const productId of productIds) await enqueueProductStockFlush({ productId, reason: 'manual_retry' });
    res.status(202).json({ reset, queuedProducts: productIds.length });
  }),
);
