import type { Setting } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';

const CACHE_KEY = `${env.QUEUE_PREFIX}:settings`;
const CACHE_TTL_SECONDS = 300;

const SETTINGS_DEFAULTS = {
  id: 1,
  pricingModel: 'EXCEL_MARKUP' as const,
  usdExchangeRate: '0',
  targetProfitMarginPercent: '200',
  packagingCost: '0',
  cargoBaremLimit: '300',
  upperBaremCargoCost: '0',
  lowerBaremCargoCost: '0',
  standardCargoCost: '0',
  enYenilerExtraMargin: '10',
  enYenilerDiscountPercent: '0',
  cargoTestBase: '1.019',
  enYenilerBase: '1.018',
  priceRoundingStrategy: 'NONE',
};

/** Fiyati etkileyen alanlar; bunlardan biri degisirse yeniden hesaplama tetiklenir. */
const PRICE_AFFECTING_FIELDS: (keyof Setting)[] = [
  'pricingModel',
  'usdExchangeRate',
  'targetProfitMarginPercent',
  'packagingCost',
  'cargoBaremLimit',
  'upperBaremCargoCost',
  'lowerBaremCargoCost',
  'standardCargoCost',
  'enYenilerExtraMargin',
  'enYenilerDiscountPercent',
  'cargoTestBase',
  'enYenilerBase',
  'priceRoundingStrategy',
];

function reviveSetting(raw: string): Setting {
  const parsed = JSON.parse(raw);
  // Prisma Decimal alanlari string olarak saklanir; motor Decimal'e cevirdigi icin sorun olmaz.
  return {
    ...parsed,
    exchangeRateUpdatedAt: parsed.exchangeRateUpdatedAt ? new Date(parsed.exchangeRateUpdatedAt) : null,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  } as Setting;
}

export async function getSettings(): Promise<Setting> {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return reviveSetting(cached);
  } catch (err) {
    logger.warn({ err }, 'Ayar onbellegi okunamadi, DB kullaniliyor');
  }

  const setting = await prisma.setting.upsert({
    where: { id: 1 },
    create: SETTINGS_DEFAULTS,
    update: {},
  });

  await cacheSettings(setting);
  return setting;
}

async function cacheSettings(setting: Setting) {
  try {
    await redis.set(CACHE_KEY, JSON.stringify(setting), 'EX', CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err }, 'Ayar onbellegi yazilamadi');
  }
}

export async function invalidateSettingsCache() {
  try {
    await redis.del(CACHE_KEY);
  } catch (err) {
    logger.warn({ err }, 'Ayar onbellegi temizlenemedi');
  }
}

export interface UpdateSettingsInput {
  pricingModel?: 'EXCEL_MARKUP' | 'REVERSE_COMMISSION';
  usdExchangeRate?: string | number;
  targetProfitMarginPercent?: string | number;
  packagingCost?: string | number;
  cargoBaremLimit?: string | number;
  upperBaremCargoCost?: string | number;
  lowerBaremCargoCost?: string | number;
  standardCargoCost?: string | number;
  enYenilerExtraMargin?: string | number;
  enYenilerDiscountPercent?: string | number;
  cargoTestBase?: string | number;
  enYenilerBase?: string | number;
  priceRoundingStrategy?: 'NONE' | 'ROUND_2' | 'PSYCHOLOGICAL_99';
  exchangeRateSource?: string;
  exchangeRateUpdatedAt?: Date;
  sentosWarehouseId?: number | null;
}

/**
 * Ayarlari gunceller ve "Observer" gorevi gorur:
 * fiyati etkileyen bir alan degistiyse toplu yeniden hesaplama kuyruga atilir.
 */
export async function updateSettings(input: UpdateSettingsInput, options: { triggerRecalculation?: boolean } = {}) {
  const before = await getSettings();

  const updated = await prisma.setting.upsert({
    where: { id: 1 },
    create: { ...SETTINGS_DEFAULTS, ...input },
    update: input,
  });

  await cacheSettings(updated);

  const changedFields = PRICE_AFFECTING_FIELDS.filter(
    (field) => String(before[field] ?? '') !== String(updated[field] ?? ''),
  );

  const shouldTrigger = options.triggerRecalculation !== false && changedFields.length > 0;

  if (shouldTrigger) {
    // Dairesel import olusmamasi icin kuyruk modulu tembel yuklenir.
    const { enqueueFullRecalculation } = await import('../../queues/producers.js');
    await enqueueFullRecalculation({ reason: `settings_changed:${changedFields.join(',')}` });
    logger.info({ changedFields }, 'Ayar degisti, toplu fiyat yeniden hesaplama kuyruga alindi');
  }

  return { settings: updated, changedFields, recalculationQueued: shouldTrigger };
}
