import { SyncStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { enqueuePricePushChunks } from '../../queues/producers.js';
import { sentosClient, SentosClient } from '../sentos/sentos.client.js';
import { toSentosPriceItem } from '../sentos/sentos.mapper.js';
import { markPriceSyncResult } from '../sentos/sentos.service.js';
import { findPendingPrices } from './pricing.service.js';

/**
 * Bekleyen (PENDING/FAILED) fiyat satirlarini kuyruga alir.
 * Kuyruga alinan satirlar QUEUED isaretlenir; boylece art arda calisan
 * gorevler ayni satiri iki kez gondermez.
 */
export async function queuePendingPricePushes(reason: string, limit = 10000) {
  const pending = await findPendingPrices(limit);
  const ids = pending.map((row) => row.id);

  if (ids.length === 0) {
    logger.info({ reason }, 'Gonderilecek bekleyen fiyat yok');
    return { chunks: 0, prices: 0 };
  }

  await prisma.variantPrice.updateMany({ where: { id: { in: ids } }, data: { syncStatus: SyncStatus.QUEUED } });
  return enqueuePricePushChunks(ids, reason);
}

/** Tek bir chunk'i Sentos'a gonderir. Kuyruk worker'i tarafindan cagrilir. */
export async function pushPriceChunk(priceIds: number[], attempt = 1) {
  const rows = await prisma.variantPrice.findMany({
    where: { id: { in: priceIds } },
    include: { variant: true },
  });

  if (rows.length === 0) return { sent: 0, dryRun: false };

  const items = rows.map(toSentosPriceItem);
  const result = await sentosClient.pushPrices(items, attempt);

  if (result.ok) {
    await markPriceSyncResult(
      rows.map((r) => r.id),
      SyncStatus.SUCCESS,
    );
    return { sent: items.length, dryRun: result.dryRun };
  }

  await markPriceSyncResult(
    rows.map((r) => r.id),
    SyncStatus.FAILED,
    result.error,
  );

  if (SentosClient.isRetryable(result)) {
    // BullMQ ustel geri cekilme ile tekrar denesin.
    throw new Error(`Sentos fiyat aktarimi gecici hata (${result.httpStatus ?? 'network'}): ${result.error}`);
  }

  logger.error({ httpStatus: result.httpStatus, error: result.error }, 'Sentos fiyat aktarimi kalici hata');
  return { sent: 0, failed: items.length, dryRun: false };
}
