import { Worker, type Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';
import { JOB_NAMES, QUEUE_NAMES, QUEUE_PREFIX } from './queues.js';
import type {
  FlushProductStockJobData,
  PushPriceChunkJobData,
  RecalculateAllJobData,
  RecalculateVariantJobData,
} from './producers.js';
import { recalculateAll, recalculateVariant } from '../modules/pricing/pricing.service.js';
import { pushPriceChunk, queuePendingPricePushes } from '../modules/pricing/price-sync.service.js';
import { processWebhookEvent } from '../modules/sentos/sentos.service.js';
import { flushProductStock, syncProductsFromSentos } from '../modules/sentos/sentos-sync.service.js';
import { syncUsdRate } from '../modules/exchange/tcmb.service.js';
import { syncOrdersFromSentos } from '../modules/orders/orders-sync.service.js';

const connection = redis;

/**
 * Sentos kuyruklarinda rate limiter zorunludur: IP ban riskini onlemek icin
 * saniyede en fazla SENTOS_RATE_LIMIT_PER_SECOND istek gonderilir.
 */
const sentosLimiter = { max: env.SENTOS_RATE_LIMIT_PER_SECOND, duration: 1000 };

/** Her stok isi 1 GET + 1 PUT yapar; Sentos'un dakikalik limiti asilmaz. */
const sentosStockLimiter = {
  max: Math.max(1, Math.floor(env.SENTOS_REQUESTS_PER_MINUTE / 2)),
  duration: 60000,
};

export function startWorkers() {
  const workers: Worker[] = [];

  // --- Fiyat hesaplama kuyrugu ---
  workers.push(
    new Worker(
      QUEUE_NAMES.pricing,
      async (job: Job) => {
        if (job.name === JOB_NAMES.recalculateAll) {
          const data = job.data as RecalculateAllJobData;
          const result = await recalculateAll({ variantIds: data.variantIds });
          // Degisen fiyatlar varsa aktarim kuyrugu doldurulur.
          const queued = await queuePendingPricePushes(`recalc:${data.reason}`);
          return { ...result, ...queued };
        }

        if (job.name === JOB_NAMES.recalculateVariant) {
          const data = job.data as RecalculateVariantJobData;
          const result = await recalculateVariant(data.variantId, data.marketplaces);
          const queued = await queuePendingPricePushes(`recalc-variant:${data.reason}`);
          return { changed: result.changed, failed: result.failed.length, ...queued };
        }

        throw new Error(`Bilinmeyen is: ${job.name}`);
      },
      { connection, prefix: QUEUE_PREFIX, concurrency: 1 }, // toplu hesaplama tek akista calisir
    ),
  );

  // --- Sentos fiyat aktarim kuyrugu ---
  workers.push(
    new Worker(
      QUEUE_NAMES.sentosPrice,
      async (job: Job) => {
        const data = job.data as PushPriceChunkJobData;
        return pushPriceChunk(data.priceIds, job.attemptsMade + 1);
      },
      { connection, prefix: QUEUE_PREFIX, concurrency: 2, limiter: sentosLimiter },
    ),
  );

  // --- Sentos stok aktarim kuyrugu ---
  workers.push(
    new Worker(
      QUEUE_NAMES.sentosStock,
      async (job: Job) => {
        const data = job.data as FlushProductStockJobData;
        return flushProductStock(data.productId, job.attemptsMade + 1);
      },
      { connection, prefix: QUEUE_PREFIX, concurrency: 2, limiter: sentosStockLimiter },
    ),
  );

  // --- Bakim kuyrugu (webhook isleme, kur, stok mutabakati) ---
  workers.push(
    new Worker(
      QUEUE_NAMES.maintenance,
      async (job: Job) => {
        switch (job.name) {
          case JOB_NAMES.processWebhook:
            return processWebhookEvent((job.data as { webhookEventId: number }).webhookEventId);
          case JOB_NAMES.fetchExchangeRate:
            return syncUsdRate({ triggerRecalculation: false });
          case JOB_NAMES.syncProducts:
            return syncProductsFromSentos((job.data as { reason: string }).reason);
          case JOB_NAMES.syncOrders:
            return syncOrdersFromSentos(job.data as { reason: string; full?: boolean });
          default:
            throw new Error(`Bilinmeyen is: ${job.name}`);
        }
      },
      { connection, prefix: QUEUE_PREFIX, concurrency: 3 },
    ),
  );

  for (const worker of workers) {
    worker.on('completed', (job, result) => {
      logger.info({ queue: worker.name, job: job.name, id: job.id, result }, 'Is tamamlandi');
    });
    worker.on('failed', (job, err) => {
      logger.error(
        { queue: worker.name, job: job?.name, id: job?.id, attempt: job?.attemptsMade, err: err.message },
        'Is basarisiz',
      );
    });
  }

  logger.info({ queues: Object.values(QUEUE_NAMES) }, 'Worker havuzu baslatildi');
  return workers;
}
