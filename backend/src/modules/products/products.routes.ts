import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../http/middleware/error.js';
import { enqueueVariantRecalculation } from '../../queues/producers.js';
import { adjustStock } from '../wms/wms.service.js';

export const productsRouter = Router();

const listQuerySchema = z.object({
  q: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  category: z.string().trim().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(200).default(25),
});

productsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, brand, category, page, pageSize } = listQuerySchema.parse(req.query);

    const where: Prisma.ProductWhereInput = {
      ...(brand ? { brand } : {}),
      ...(category ? { category } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { mainProductCode: { contains: q, mode: 'insensitive' } },
              { variants: { some: { barcode: { contains: q } } } },
              { variants: { some: { variantCode: { contains: q, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { variants: { include: { prices: true }, orderBy: { variantCode: 'asc' } } },
        orderBy: { mainProductCode: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    res.json({ items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
  }),
);

productsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: Number(req.params.id) },
      include: { variants: { include: { prices: true }, orderBy: { variantCode: 'asc' } } },
    });
    res.json(product);
  }),
);

const productSchema = z.object({
  mainProductCode: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
});

productsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = productSchema.parse(req.body);
    const product = await prisma.product.create({ data });
    res.status(201).json(product);
  }),
);

productsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = productSchema.partial().parse(req.body);
    const product = await prisma.product.update({ where: { id: Number(req.params.id) }, data });
    res.json(product);
  }),
);

// --- Varyantlar ---

export const variantsRouter = Router();

const variantSchema = z.object({
  productId: z.number().int().positive(),
  variantCode: z.string().min(1),
  barcode: z.string().min(1),
  sentosStockCode: z.string().optional(),
  color: z.string().optional(),
  size: z.string().optional(),
  model: z.string().optional(),
  purchasePriceUsd: z.union([z.number(), z.string()]).optional(),
  customsTaxUsd: z.union([z.number(), z.string()]).optional(),
  freightCostUsd: z.union([z.number(), z.string()]).optional(),
  extraLossMargin: z.union([z.number(), z.string()]).optional(),
  commissionPercent: z.union([z.number(), z.string()]).nullable().optional(),
  extraCommissionPercent: z.union([z.number(), z.string()]).nullable().optional(),
  applyEnYeniler: z.boolean().optional(),
  stockQuantity: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  imageUrl: z.string().url().optional(),
});

const variantListQuery = z.object({
  q: z.string().trim().optional(),
  lowStock: z.coerce.boolean().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(500).default(50),
});

variantsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { q, lowStock, page, pageSize } = variantListQuery.parse(req.query);

    const where: Prisma.ProductVariantWhereInput = {
      ...(lowStock ? { stockQuantity: { lte: 3 } } : {}),
      ...(q
        ? {
            OR: [
              { variantCode: { contains: q, mode: 'insensitive' } },
              { barcode: { contains: q } },
              { sentosStockCode: { contains: q, mode: 'insensitive' } },
              { product: { name: { contains: q, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.productVariant.findMany({
        where,
        include: { product: true, prices: true },
        orderBy: { variantCode: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.productVariant.count({ where }),
    ]);

    res.json({ items, total, page, pageSize, pageCount: Math.ceil(total / pageSize) });
  }),
);

variantsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: Number(req.params.id) },
      include: { product: true, prices: true, movements: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    res.json(variant);
  }),
);

variantsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = variantSchema.parse(req.body);
    const variant = await prisma.productVariant.create({ data });
    await enqueueVariantRecalculation({ variantId: variant.id, reason: 'variant_created' });
    res.status(201).json(variant);
  }),
);

/** Maliyet alanlari degistiginde fiyat yeniden hesaplama otomatik tetiklenir. */
variantsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = variantSchema.partial().parse(req.body);
    const variant = await prisma.productVariant.update({ where: { id: Number(req.params.id) }, data });

    const priceFields = [
      'purchasePriceUsd',
      'customsTaxUsd',
      'freightCostUsd',
      'extraLossMargin',
      'commissionPercent',
      'extraCommissionPercent',
      'applyEnYeniler',
    ];
    if (priceFields.some((field) => field in data)) {
      await enqueueVariantRecalculation({ variantId: variant.id, reason: 'variant_cost_changed' });
    }

    res.json(variant);
  }),
);

const stockSchema = z.object({
  newQuantity: z.number().int().min(0),
  note: z.string().optional(),
});

variantsRouter.patch(
  '/:id/stock',
  asyncHandler(async (req, res) => {
    const { newQuantity, note } = stockSchema.parse(req.body);
    const variant = await adjustStock({
      variantId: Number(req.params.id),
      newQuantity,
      note,
      operator: req.operator ?? 'panel',
    });
    res.json(variant);
  }),
);
