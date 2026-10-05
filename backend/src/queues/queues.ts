import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import { redis } from '../lib/redis.js';
import { env } from '../config/env.js';

// BullMQ kuyruk adinda ":" kullanilamaz; ayristirma prefix secenegiyle yapilir.
export const QUEUE_PREFIX = env.QUEUE_PREFIX;

export const QUEUE_NAMES = {
  pricing: 'pricing',
  sentosPrice: 'sentos-price',
  sentosStock: 'sentos-stock',
  maintenance: 'maintenance',
} as const;

export const JOB_NAMES = {
  recalculateAll: 'recalculate-all',
  recalculateVariant: 'recalculate-variant',
  pushPriceChunk: 'push-price-chunk',
  flushProductStock: 'flush-product-stock',
  syncProducts: 'sync-products',
  syncOrders: 'sync-orders',
  fetchExchangeRate: 'fetch-exchange-rate',
  processWebhook: 'process-webhook',
} as const;

/** Dis API hatalarinda ustel geri cekilme; kalici kuyruk sismesini onlemek icin temizlik ayarlari. */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 3600, count: 5000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

const connection = redis;
const queueOptions = { connection, prefix: QUEUE_PREFIX, defaultJobOptions };

export const pricingQueue = new Queue(QUEUE_NAMES.pricing, queueOptions);
export const sentosPriceQueue = new Queue(QUEUE_NAMES.sentosPrice, queueOptions);
export const sentosStockQueue = new Queue(QUEUE_NAMES.sentosStock, queueOptions);
export const maintenanceQueue = new Queue(QUEUE_NAMES.maintenance, queueOptions);

export const allQueues = [pricingQueue, sentosPriceQueue, sentosStockQueue, maintenanceQueue];

export function createQueueEvents(name: string) {
  return new QueueEvents(name, { connection: redis.duplicate(), prefix: QUEUE_PREFIX });
}

export async function closeQueues() {
  await Promise.all(allQueues.map((queue) => queue.close()));
}
