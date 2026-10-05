import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/middleware/error.js';
import { getCachedWarehouses } from '../sentos/sentos-sync.service.js';
import { findByBarcode, listMovements, scanOut, searchVariants, todaySummary } from './wms.service.js';

export const wmsRouter = Router();

const lookupSchema = z.object({ barcode: z.string().min(1) });

/** Barkod sorgulama (stok dusurmeden onizleme). */
wmsRouter.get(
  '/lookup',
  asyncHandler(async (req, res) => {
    const { barcode } = lookupSchema.parse(req.query);
    const variant = await findByBarcode(barcode);
    res.json(toTerminalPayload(variant));
  }),
);

/** Urun secimi icin arama (ad / SKU / barkod). */
wmsRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { q, limit } = z
      .object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(50).default(20) })
      .parse(req.query);
    const items = await searchVariants(q, limit);
    res.json({ items: items.map(toTerminalPayload) });
  }),
);

const scanSchema = z.object({
  barcode: z.string().min(1),
  quantity: z.number().int().positive().max(999).default(1),
  reference: z.string().optional(),
  expectedVariantId: z.number().int().positive().optional(),
});

/**
 * Depo cikisi. Basarili cevap terminalde "BIP" sesi ve urun gorseli icin
 * gereken tum alanlari dondurur.
 */
wmsRouter.post(
  '/scan',
  asyncHandler(async (req, res) => {
    const body = scanSchema.parse(req.body);
    const variant = await scanOut({
      barcode: body.barcode,
      quantity: body.quantity,
      reference: body.reference,
      expectedVariantId: body.expectedVariantId,
      operator: req.operator ?? 'terminal',
    });

    res.json({ ok: true, message: 'Stok dusuldu', ...toTerminalPayload(variant) });
  }),
);

wmsRouter.get(
  '/movements',
  asyncHandler(async (req, res) => {
    const schema = z.object({
      variantId: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      operator: z.string().optional(),
    });
    const params = schema.parse(req.query);
    res.json({ items: await listMovements(params) });
  }),
);

/** Depo adlari (onbellekten; terminal Sentos'a dogrudan istek atmaz). */
wmsRouter.get(
  '/warehouses',
  asyncHandler(async (_req, res) => {
    res.json({ items: await getCachedWarehouses() });
  }),
);

wmsRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    res.json(await todaySummary());
  }),
);

function toTerminalPayload(variant: {
  id: number;
  variantCode: string;
  barcode: string;
  color: string | null;
  size: string | null;
  stockQuantity: number;
  reservedQuantity: number;
  imageUrl: string | null;
  sentosProductId: number | null;
  sentosStockCode: string | null;
  warehouseStocks: unknown;
  pendingSentosDelta: number;
  lastSentosError: string | null;
  product: { name: string; brand: string | null; mainProductCode: string; imageUrl: string | null };
}) {
  return {
    variant: {
      id: variant.id,
      variantCode: variant.variantCode,
      barcode: variant.barcode,
      color: variant.color,
      size: variant.size,
      stockQuantity: variant.stockQuantity,
      reservedQuantity: variant.reservedQuantity,
      availableQuantity: Math.max(0, variant.stockQuantity - variant.reservedQuantity),
      imageUrl: variant.imageUrl ?? variant.product.imageUrl,
      sentosLinked: variant.sentosProductId !== null,
      sentosStockCode: variant.sentosStockCode,
      warehouseStocks: Array.isArray(variant.warehouseStocks) ? variant.warehouseStocks : [],
      pendingSentosDelta: variant.pendingSentosDelta,
      lastSentosError: variant.lastSentosError,
    },
    product: {
      name: variant.product.name,
      brand: variant.product.brand,
      mainProductCode: variant.product.mainProductCode,
    },
  };
}
