import { Router } from 'express';
import { Marketplace, SyncStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../http/middleware/error.js';
import { calculatePrice } from './pricing.engine.js';
import { previewVariant, toEngineSettings } from './pricing.service.js';
import { queuePendingPricePushes } from './price-sync.service.js';
import { enqueueFullRecalculation, enqueueVariantRecalculation } from '../../queues/producers.js';
import { allQueues } from '../../queues/queues.js';
import { getSettings } from '../settings/settings.service.js';

export const pricingRouter = Router();

/** Decimal/boolean karisik nesneleri JSON'a cevirir (hassasiyet kaybi olmadan). */
function serializeMap(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      value === null || value === undefined || typeof value === 'boolean' || typeof value === 'string'
        ? value
        : String(value),
    ]),
  );
}

const numeric = z.union([z.number(), z.string()]);

const simulateSchema = z.object({
  variant: z.object({
    purchasePriceUsd: numeric,
    customsTaxUsd: numeric.default(0),
    freightCostUsd: numeric.default(0),
    extraLossMargin: numeric.default(0),
    applyEnYeniler: z.boolean().default(false),
  }),
  commission: z.object({
    commissionPercent: numeric,
    extraCommissionPercent: numeric.default(0),
  }),
  settings: z
    .object({
      pricingModel: z.enum(['EXCEL_MARKUP', 'REVERSE_COMMISSION']).optional(),
      usdExchangeRate: numeric.optional(),
      targetProfitMarginPercent: numeric.optional(),
      packagingCost: numeric.optional(),
      cargoBaremLimit: numeric.optional(),
      upperBaremCargoCost: numeric.optional(),
      lowerBaremCargoCost: numeric.optional(),
      standardCargoCost: numeric.optional(),
      enYenilerExtraMargin: numeric.optional(),
      enYenilerDiscountPercent: numeric.optional(),
      cargoTestBase: numeric.optional(),
      enYenilerBase: numeric.optional(),
      priceRoundingStrategy: z.enum(['NONE', 'ROUND_2', 'PSYCHOLOGICAL_99']).optional(),
    })
    .optional(),
  marketplace: z
    .object({
      cargoBaremLimit: numeric.optional(),
      extraFarkPercent: numeric.optional(),
      marketPriceMarkupPercent: numeric.optional(),
      usesCargo: z.boolean().optional(),
      usesCommission: z.boolean().optional(),
      isEnYeniler: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Kaydetmeden hesaplama. Panelde alanlar degistikce cagrilir; DB'ye dokunmaz.
 * Verilmeyen ayarlar sistem ayarlarindan tamamlanir.
 */
pricingRouter.post(
  '/simulate',
  asyncHandler(async (req, res) => {
    const body = simulateSchema.parse(req.body);
    const stored = await getSettings();

    // Verilmeyen ayarlar sistem ayarlarindan tamamlanir.
    const settings = { ...toEngineSettings(stored), ...body.settings };

    const breakdown = calculatePrice(body.variant, body.commission, settings, body.marketplace ?? {});

    res.json({
      settings: serializeMap(settings),
      breakdown: serializeMap(breakdown as unknown as Record<string, unknown>),
    });
  }),
);

/** Varyantin tum pazar yerlerindeki fiyat kirilimi (kaydetmeden). */
pricingRouter.get(
  '/preview/:variantId',
  asyncHandler(async (req, res) => {
    const { variant, results, settings } = await previewVariant(Number(req.params.variantId));

    res.json({
      variant: {
        id: variant.id,
        variantCode: variant.variantCode,
        barcode: variant.barcode,
        product: variant.product.name,
        category: variant.product.category,
      },
      settings: serializeMap(settings as Record<string, unknown>),
      results: results.map((r) => ({
        marketplace: r.marketplace,
        categoryId: r.categoryId,
        error: r.error,
        breakdown: r.breakdown ? serializeMap(r.breakdown as unknown as Record<string, unknown>) : undefined,
      })),
    });
  }),
);

pricingRouter.post(
  '/recalculate',
  asyncHandler(async (req, res) => {
    const schema = z.object({ variantIds: z.array(z.number().int().positive()).optional() });
    const { variantIds } = schema.parse(req.body ?? {});
    const job = await enqueueFullRecalculation({ reason: 'manual', variantIds });
    res.status(202).json({ queued: true, jobId: job.id });
  }),
);

pricingRouter.post(
  '/recalculate/:variantId',
  asyncHandler(async (req, res) => {
    const marketplaces = z.array(z.nativeEnum(Marketplace)).optional().parse(req.body?.marketplaces);
    const job = await enqueueVariantRecalculation({
      variantId: Number(req.params.variantId),
      reason: 'manual',
      marketplaces,
    });
    res.status(202).json({ queued: true, jobId: job.id });
  }),
);

/** "Fiyatlari Sentos'a gonder" butonu: bekleyenleri chunk'layip kuyruga atar. */
pricingRouter.post(
  '/push',
  asyncHandler(async (_req, res) => {
    const result = await queuePendingPricePushes('manual_push');
    res.status(202).json({ queued: true, ...result });
  }),
);

pricingRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const [byStatus, queueCounts] = await Promise.all([
      prisma.variantPrice.groupBy({ by: ['syncStatus'], _count: { _all: true } }),
      Promise.all(
        allQueues.map(async (queue) => ({
          queue: queue.name,
          counts: await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
        })),
      ),
    ]);

    res.json({
      prices: Object.fromEntries(
        Object.values(SyncStatus).map((status) => [
          status,
          byStatus.find((row) => row.syncStatus === status)?._count._all ?? 0,
        ]),
      ),
      queues: queueCounts,
    });
  }),
);
