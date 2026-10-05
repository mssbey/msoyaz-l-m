import crypto from 'node:crypto';
import { SyncStatus, WebhookStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { reserveForOrder } from '../wms/wms.service.js';
import { enqueueWebhookProcessing } from '../../queues/producers.js';
import { normalizeOrderWebhook } from './sentos.mapper.js';

/** HMAC-SHA256 imza dogrulama. Secret tanimli degilse kontrol atlanir. */
export function verifyWebhookSignature(rawBody: Buffer | string, signature?: string): boolean {
  if (!env.SENTOS_WEBHOOK_SECRET) return true;
  if (!signature) return false;

  const expected = crypto.createHmac('sha256', env.SENTOS_WEBHOOK_SECRET).update(rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/, '');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Webhook alindiginda once kaydedilir (idempotency), sonra kuyruga atilir.
 * Boylece Sentos'a 200 yanitini beklemeden hizli donulur ve tekrar gonderimlerde
 * ayni siparis iki kez dusulmez.
 */
export async function ingestOrderWebhook(body: unknown) {
  const normalized = normalizeOrderWebhook(body);

  const existing = await prisma.webhookEvent.findUnique({
    where: {
      source_eventType_externalId: {
        source: 'SENTOS',
        eventType: normalized.eventType,
        externalId: normalized.orderId,
      },
    },
  });

  if (existing) {
    logger.info({ orderId: normalized.orderId }, 'Webhook zaten islenmis (duplicate)');
    return { duplicate: true, eventId: existing.id, orderId: normalized.orderId };
  }

  const event = await prisma.webhookEvent.create({
    data: {
      source: 'SENTOS',
      eventType: normalized.eventType,
      externalId: normalized.orderId,
      payload: body as object,
      status: WebhookStatus.RECEIVED,
    },
  });

  await enqueueWebhookProcessing(event.id);
  return { duplicate: false, eventId: event.id, orderId: normalized.orderId, lines: normalized.lines.length };
}

/** Kuyruktan calisan asil isleme adimi: stok rezervasyonu. */
export async function processWebhookEvent(eventId: number) {
  const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
  if (!event) throw new Error(`Webhook kaydi bulunamadi: ${eventId}`);
  if (event.status === WebhookStatus.PROCESSED) {
    return { skipped: true, reason: 'already_processed' };
  }

  try {
    const normalized = normalizeOrderWebhook(event.payload);
    const result = await reserveForOrder(normalized.lines, normalized.orderId);

    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        status: WebhookStatus.PROCESSED,
        processedAt: new Date(),
        error: result.notFound.length ? `Eslesmeyen stok kodlari: ${result.notFound.join(', ')}` : null,
      },
    });

    return { skipped: false, ...result };
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: eventId },
      data: { status: WebhookStatus.FAILED, error: (err as Error).message },
    });
    throw err;
  }
}

/** Fiyat satirlarini basarili/basarisiz olarak isaretler. */
export async function markPriceSyncResult(priceIds: number[], status: SyncStatus, error?: string) {
  await prisma.variantPrice.updateMany({
    where: { id: { in: priceIds } },
    data: {
      syncStatus: status,
      syncedAt: status === SyncStatus.SUCCESS ? new Date() : undefined,
      lastSyncError: error ?? null,
    },
  });
}
