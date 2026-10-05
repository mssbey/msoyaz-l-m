import type { Marketplace } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JOB_NAMES, maintenanceQueue, pricingQueue, sentosPriceQueue, sentosStockQueue } from './queues.js';

export interface RecalculateAllJobData {
  reason: string;
  variantIds?: number[];
}

export interface RecalculateVariantJobData {
  variantId: number;
  reason: string;
  marketplaces?: Marketplace[];
}

export interface PushPriceChunkJobData {
  priceIds: number[];
  reason: string;
}

export interface FlushProductStockJobData {
  productId: number;
  reason: string;
}

export async function enqueueFullRecalculation(data: RecalculateAllJobData) {
  // jobId sabit tutularak ayni anda birden fazla toplu hesaplama calismasi engellenir.
  return pricingQueue.add(JOB_NAMES.recalculateAll, data, {
    jobId: `recalc-all-${Date.now()}`,
    attempts: 3,
  });
}

export async function enqueueVariantRecalculation(data: RecalculateVariantJobData) {
  return pricingQueue.add(JOB_NAMES.recalculateVariant, data, {
    jobId: `recalc-variant-${data.variantId}-${Date.now()}`,
  });
}

/**
 * Bekleyen fiyatlari SENTOS_CHUNK_SIZE'lik parcalara bolerek kuyruga atar.
 * ~3200 fiyat guncellemesi tek seferde degil, worker'in rate limit'i kadar akar.
 */
export async function enqueuePricePushChunks(priceIds: number[], reason: string) {
  const chunkSize = env.SENTOS_CHUNK_SIZE;
  const jobs = [];

  for (let i = 0; i < priceIds.length; i += chunkSize) {
    const chunk = priceIds.slice(i, i + chunkSize);
    jobs.push({
      name: JOB_NAMES.pushPriceChunk,
      data: { priceIds: chunk, reason } satisfies PushPriceChunkJobData,
    });
  }

  if (jobs.length === 0) return { chunks: 0, prices: 0 };

  await sentosPriceQueue.addBulk(jobs);
  logger.info({ chunks: jobs.length, prices: priceIds.length, reason }, 'Fiyat aktarim kuyrugu dolduruldu');
  return { chunks: jobs.length, prices: priceIds.length };
}

/**
 * Urunun bekleyen stok farklarini Sentos'a iletme isi.
 * Sabit jobId + gecikme ile ayni urune art arda yapilan okutmalar tek istekte birlesir;
 * is calisirken gelen okutmalar dakikalik CRON taramasiyla iletilir.
 */
export async function enqueueProductStockFlush(data: FlushProductStockJobData) {
  return sentosStockQueue.add(JOB_NAMES.flushProductStock, data, {
    jobId: `stock-p${data.productId}`,
    delay: env.SENTOS_STOCK_DEBOUNCE_MS,
    removeOnComplete: true,
    removeOnFail: true,
  });
}

/** Sentos'tan urun + stok cekme (tek seferde yalnizca bir tane calisir). */
export async function enqueueProductSync(reason = 'cron') {
  return maintenanceQueue.add(
    JOB_NAMES.syncProducts,
    { reason },
    { jobId: `sync-products-${Date.now()}`, attempts: 1 },
  );
}

/** Sentos'tan siparis cekme (salt okuma). Kilit sayesinde ayni anda tek tur calisir. */
export async function enqueueOrderSync(reason = 'cron', full = false) {
  return maintenanceQueue.add(
    JOB_NAMES.syncOrders,
    { reason, full },
    { jobId: `sync-orders-${Date.now()}`, attempts: 1 },
  );
}

export async function enqueueExchangeRateFetch(reason = 'cron') {
  return maintenanceQueue.add(JOB_NAMES.fetchExchangeRate, { reason }, { jobId: `fx-${Date.now()}` });
}

export async function enqueueWebhookProcessing(webhookEventId: number) {
  return maintenanceQueue.add(
    JOB_NAMES.processWebhook,
    { webhookEventId },
    { jobId: `webhook-${webhookEventId}` },
  );
}
