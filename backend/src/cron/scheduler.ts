import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  enqueueExchangeRateFetch,
  enqueueFullRecalculation,
  enqueueOrderSync,
  enqueueProductStockFlush,
  enqueueProductSync,
} from '../queues/producers.js';
import { findProductsWithPendingStock } from '../modules/sentos/sentos-sync.service.js';
import { queuePendingPricePushes } from '../modules/pricing/price-sync.service.js';

/**
 * Zamanlanmis gorevler (spesifikasyon Bolum 6).
 * Gorevler isi kendisi yapmaz; sadece kuyruga birakir. Boylece CRON tetiklemesi
 * hicbir zaman uzun sure bloklanmaz ve tekrar denemeler BullMQ'ya kalir.
 */
export function startCron() {
  if (!env.CRON_ENABLED) {
    logger.warn('CRON devre disi (CRON_ENABLED=false)');
    return [];
  }

  const options = { timezone: env.TZ } as const;

  const tasks = [
    // 03:00 - TCMB'den guncel USD kuru
    cron.schedule(
      env.CRON_FX_UPDATE,
      async () => {
        logger.info('CRON: TCMB kur guncellemesi kuyruga alindi');
        await enqueueExchangeRateFetch('cron');
      },
      options,
    ),

    // 03:10 - Tum varyantlarin fiyatlarinin yeniden hesaplanmasi
    cron.schedule(
      env.CRON_PRICE_RECALC,
      async () => {
        logger.info('CRON: Toplu fiyat yeniden hesaplama kuyruga alindi');
        await enqueueFullRecalculation({ reason: 'cron_daily' });
      },
      options,
    ),

    // 03:30 - Degisen fiyatlarin Sentos'a aktarimi
    cron.schedule(
      env.CRON_PRICE_PUSH,
      async () => {
        logger.info('CRON: Fiyat aktarim kuyrugu dolduruluyor');
        await queuePendingPricePushes('cron_daily_push');
      },
      options,
    ),

    // Her 15 dakika - Sentos'tan urun ve stoklarin cekilmesi (Sentos dogru kabul edilir)
    cron.schedule(
      env.CRON_STOCK_CHECK,
      async () => {
        logger.debug('CRON: Sentos urun/stok senkronu kuyruga alindi');
        await enqueueProductSync('cron');
      },
      options,
    ),

    // Her 2 dakika - Sentos'tan yeni/guncellenen siparislerin cekilmesi (yalnizca okuma)
    cron.schedule(
      env.CRON_ORDER_SYNC,
      async () => {
        logger.debug('CRON: Sentos siparis senkronu kuyruga alindi');
        await enqueueOrderSync('cron');
      },
      options,
    ),

    // Her dakika - Sentos'a iletilmemis okutmalarin taranmasi
    cron.schedule(
      env.CRON_STOCK_FLUSH,
      async () => {
        const productIds = await findProductsWithPendingStock();
        for (const productId of productIds) {
          await enqueueProductStockFlush({ productId, reason: 'cron_sweep' });
        }
        if (productIds.length) logger.info({ products: productIds.length }, 'CRON: Bekleyen stok aktarimlari kuyruga alindi');
      },
      options,
    ),
  ];

  logger.info(
    {
      fx: env.CRON_FX_UPDATE,
      recalc: env.CRON_PRICE_RECALC,
      push: env.CRON_PRICE_PUSH,
      productSync: env.CRON_STOCK_CHECK,
      stockFlush: env.CRON_STOCK_FLUSH,
      orderSync: env.CRON_ORDER_SYNC,
      tz: env.TZ,
    },
    'CRON gorevleri baslatildi',
  );

  return tasks;
}
