import IORedis from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ, blocking komutlar kullandigi icin maxRetriesPerRequest: null zorunlu.
 * Ayni baglanti hem kuyruk hem worker tarafindan paylasilir.
 */
export const redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

export async function disconnectRedis() {
  await redis.quit();
}
