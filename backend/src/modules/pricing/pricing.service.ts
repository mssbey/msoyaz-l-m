import { Marketplace, Prisma, SyncStatus, type Setting } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { toDb, type RoundingStrategy } from '../../lib/money.js';
import { getSettings } from '../settings/settings.service.js';
import {
  calculatePrice,
  PricingError,
  type MarketplaceConfigInput,
  type PriceBreakdown,
  type PricingModel,
  type PricingSettingsInput,
} from './pricing.engine.js';

export interface MarketplacePriceResult {
  marketplace: Marketplace;
  categoryId: string;
  breakdown?: PriceBreakdown;
  error?: string;
}

/** Fiyat hesabinda kullanilan tum pazar yeri parametreleri tek seferde okunur. */
export async function loadMarketplaceIndex() {
  const [settingsRows, commissionRows] = await Promise.all([
    prisma.marketplaceSetting.findMany({ where: { isActive: true } }),
    prisma.marketplaceCommission.findMany({ where: { isActive: true } }),
  ]);

  const commissionIndex = new Map<string, (typeof commissionRows)[number]>();
  for (const row of commissionRows) commissionIndex.set(`${row.marketplace}::${row.categoryId}`, row);

  const settingIndex = new Map<Marketplace, (typeof settingsRows)[number]>();
  for (const row of settingsRows) settingIndex.set(row.marketplace, row);

  // Pazar yeri listesi once marketplace_settings'ten, yoksa komisyon tanimlarindan gelir.
  const marketplaces = settingsRows.length
    ? settingsRows.map((row) => row.marketplace)
    : [...new Set(commissionRows.map((row) => row.marketplace))];

  return {
    marketplaces,
    config(marketplace: Marketplace): MarketplaceConfigInput {
      const row = settingIndex.get(marketplace);
      return {
        cargoBaremLimit: row?.cargoBaremLimit ?? null,
        extraFarkPercent: row?.extraFarkPercent ?? 0,
        marketPriceMarkupPercent: row?.marketPriceMarkupPercent ?? 0,
        usesCargo: row?.usesCargo ?? marketplace !== Marketplace.ENY,
        usesCommission: row?.usesCommission ?? marketplace !== Marketplace.ENY,
        isEnYeniler: marketplace === Marketplace.ENY,
      };
    },
    /** Once urunun kategorisi, yoksa "*" varsayilani kullanilir. */
    commission(marketplace: Marketplace, category?: string | null) {
      if (category) {
        const specific = commissionIndex.get(`${marketplace}::${category}`);
        if (specific) return specific;
      }
      return commissionIndex.get(`${marketplace}::*`);
    },
  };
}

export type MarketplaceIndex = Awaited<ReturnType<typeof loadMarketplaceIndex>>;

export function toEngineSettings(settings: Setting): PricingSettingsInput {
  return {
    pricingModel: settings.pricingModel as PricingModel,
    usdExchangeRate: settings.usdExchangeRate,
    targetProfitMarginPercent: settings.targetProfitMarginPercent,
    packagingCost: settings.packagingCost,
    cargoBaremLimit: settings.cargoBaremLimit,
    upperBaremCargoCost: settings.upperBaremCargoCost,
    lowerBaremCargoCost: settings.lowerBaremCargoCost,
    standardCargoCost: settings.standardCargoCost,
    enYenilerExtraMargin: settings.enYenilerExtraMargin,
    enYenilerDiscountPercent: settings.enYenilerDiscountPercent,
    cargoTestBase: settings.cargoTestBase,
    enYenilerBase: settings.enYenilerBase,
    priceRoundingStrategy: settings.priceRoundingStrategy as RoundingStrategy,
  };
}

const variantWithProduct = Prisma.validator<Prisma.ProductVariantDefaultArgs>()({
  include: { product: true },
});
export type VariantWithProduct = Prisma.ProductVariantGetPayload<typeof variantWithProduct>;

/** Tek varyantin tum pazar yeri fiyatlarini hesaplar (DB'ye yazmaz). */
export function computeVariantPrices(
  variant: VariantWithProduct,
  index: MarketplaceIndex,
  settings: PricingSettingsInput,
  onlyMarketplaces?: Marketplace[],
): MarketplacePriceResult[] {
  const targets = onlyMarketplaces?.length ? onlyMarketplaces : index.marketplaces;

  return targets.map((marketplace) => {
    const commissionRow = index.commission(marketplace, variant.product.category);

    // Excel'de komisyon varyant bazindadir; tablo tanimi yalnizca yedek olarak kullanilir.
    const commissionPercent = variant.commissionPercent ?? commissionRow?.commissionPercent;
    const extraCommissionPercent = variant.extraCommissionPercent ?? commissionRow?.extraCommissionPercent;

    const config = index.config(marketplace);
    const needsCommission = config.usesCommission !== false;

    if (needsCommission && (commissionPercent === undefined || commissionPercent === null)) {
      return {
        marketplace,
        categoryId: commissionRow?.categoryId ?? '*',
        error: `${marketplace} icin komisyon orani bulunamadi (varyant ve tablo tanimi bos).`,
      };
    }

    try {
      const breakdown = calculatePrice(
        {
          purchasePriceUsd: variant.purchasePriceUsd,
          customsTaxUsd: variant.customsTaxUsd,
          freightCostUsd: variant.freightCostUsd,
          extraLossMargin: variant.extraLossMargin,
          applyEnYeniler: variant.applyEnYeniler,
        },
        {
          commissionPercent: commissionPercent ?? 0,
          extraCommissionPercent: extraCommissionPercent ?? 0,
        },
        settings,
        config,
      );
      return { marketplace, categoryId: commissionRow?.categoryId ?? '*', breakdown };
    } catch (err) {
      const message = err instanceof PricingError ? err.message : (err as Error).message;
      return { marketplace, categoryId: commissionRow?.categoryId ?? '*', error: message };
    }
  });
}

/** Hesaplanan fiyatlari variant_prices tablosuna yazar; degisen satirlari PENDING isaretler. */
export async function persistVariantPrices(
  variantId: number,
  results: MarketplacePriceResult[],
): Promise<{ changed: Marketplace[]; failed: MarketplacePriceResult[] }> {
  const changed: Marketplace[] = [];
  const failed: MarketplacePriceResult[] = [];

  const existing = await prisma.variantPrice.findMany({ where: { variantId } });
  const existingByMarketplace = new Map(existing.map((row) => [row.marketplace, row]));

  for (const result of results) {
    if (!result.breakdown) {
      failed.push(result);
      continue;
    }

    const b = result.breakdown;
    const previous = existingByMarketplace.get(result.marketplace);
    const priceChanged = !previous || !previous.salePrice.equals(toDb(b.salePrice, 6));

    const data = {
      costTry: toDb(b.costTry, 6),
      packagingCost: toDb(b.packagingCost, 6),
      profitAmount: toDb(b.profitAmount, 6),
      lossAmount: toDb(b.lossAmount, 6),
      targetRevenue: toDb(b.targetRevenue, 6),
      cargoCost: toDb(b.cargoCost, 6),
      cargoTier: b.cargoTier,
      sellerPaysCargo: b.sellerPaysCargo,
      totalCommissionPercent: toDb(b.totalCommissionPercent, 4),
      commissionAmount: toDb(b.commissionAmount, 6),
      salePrice: toDb(b.salePrice, 6),
      marketPrice: b.marketPrice ? toDb(b.marketPrice, 6) : null,
      payoutAmount: toDb(b.payoutAmount, 6),
      exchangeRateUsed: toDb(b.exchangeRateUsed, 4),
      calculatedAt: new Date(),
      ...(priceChanged ? { syncStatus: SyncStatus.PENDING, lastSyncError: null } : {}),
    };

    await prisma.variantPrice.upsert({
      where: { variantId_marketplace: { variantId, marketplace: result.marketplace } },
      create: { variantId, marketplace: result.marketplace, ...data },
      update: data,
    });

    if (priceChanged) changed.push(result.marketplace);
  }

  return { changed, failed };
}

/** Tek varyanti hesaplayip kaydeder. */
export async function recalculateVariant(variantId: number, onlyMarketplaces?: Marketplace[]) {
  const [variant, settings, index] = await Promise.all([
    prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: true } }),
    getSettings(),
    loadMarketplaceIndex(),
  ]);

  if (!variant) throw new Error(`Varyant bulunamadi: ${variantId}`);

  const results = computeVariantPrices(variant, index, toEngineSettings(settings), onlyMarketplaces);
  const persisted = await persistVariantPrices(variantId, results);

  return { variant, results, ...persisted };
}

/** Onizleme: kaydetmeden hesaplar (panelde reaktif goruntuleme icin). */
export async function previewVariant(variantId: number, overrides?: Partial<PricingSettingsInput>) {
  const [variant, settings, index] = await Promise.all([
    prisma.productVariant.findUnique({ where: { id: variantId }, include: { product: true } }),
    getSettings(),
    loadMarketplaceIndex(),
  ]);
  if (!variant) throw new Error(`Varyant bulunamadi: ${variantId}`);

  const engineSettings = { ...toEngineSettings(settings), ...overrides };
  return {
    variant,
    settings: engineSettings,
    results: computeVariantPrices(variant, index, engineSettings),
  };
}

export interface RecalculateAllOptions {
  batchSize?: number;
  onlyActive?: boolean;
  variantIds?: number[];
}

/**
 * Toplu yeniden hesaplama. 808 varyant x 6 kanal gibi hacimlerde bellegi
 * sismemesi icin sayfali (batch) calisir.
 */
export async function recalculateAll(options: RecalculateAllOptions = {}) {
  const batchSize = options.batchSize ?? 200;
  const [settings, index] = await Promise.all([getSettings(), loadMarketplaceIndex()]);
  const engineSettings = toEngineSettings(settings);

  if (index.marketplaces.length === 0) {
    throw new PricingError('Aktif pazar yeri tanimi yok. Fiyat hesaplanamaz.');
  }

  const where: Prisma.ProductVariantWhereInput = {
    ...(options.onlyActive === false ? {} : { isActive: true }),
    ...(options.variantIds?.length ? { id: { in: options.variantIds } } : {}),
  };

  let cursor: number | undefined;
  let processed = 0;
  let changedCount = 0;
  const failures: { variantCode: string; marketplace: Marketplace; error: string }[] = [];

  for (;;) {
    const variants = await prisma.productVariant.findMany({
      where,
      include: { product: true },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (variants.length === 0) break;

    for (const variant of variants) {
      const results = computeVariantPrices(variant, index, engineSettings);
      const { changed, failed } = await persistVariantPrices(variant.id, results);
      changedCount += changed.length;
      for (const f of failed) {
        failures.push({
          variantCode: variant.variantCode,
          marketplace: f.marketplace,
          error: f.error ?? 'bilinmeyen hata',
        });
      }
      processed += 1;
    }

    cursor = variants[variants.length - 1]!.id;
    if (variants.length < batchSize) break;
  }

  logger.info({ processed, changedCount, failures: failures.length }, 'Toplu fiyat hesaplama tamamlandi');
  return { processed, changedCount, failures };
}

/** Sentos'a gonderilmeyi bekleyen fiyat satirlari. */
export async function findPendingPrices(limit = 10000) {
  return prisma.variantPrice.findMany({
    where: { syncStatus: { in: [SyncStatus.PENDING, SyncStatus.FAILED] }, variant: { isActive: true } },
    include: { variant: { include: { product: true } } },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });
}
