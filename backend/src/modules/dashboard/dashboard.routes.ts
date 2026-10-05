import { Router } from 'express';
import { StockMovementType, SyncStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../http/middleware/error.js';
import { getSettings } from '../settings/settings.service.js';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [settings, productCount, variantCount, activeVariants, priceCount, pendingSync, failedSync, scansToday, lowStock, lastMovements] =
      await Promise.all([
        getSettings(),
        prisma.product.count(),
        prisma.productVariant.count(),
        prisma.productVariant.count({ where: { isActive: true } }),
        prisma.variantPrice.count(),
        prisma.variantPrice.count({ where: { syncStatus: { in: [SyncStatus.PENDING, SyncStatus.QUEUED] } } }),
        prisma.variantPrice.count({ where: { syncStatus: SyncStatus.FAILED } }),
        prisma.stockMovement.count({
          where: { type: StockMovementType.WAREHOUSE_SCAN, createdAt: { gte: startOfDay } },
        }),
        prisma.productVariant.count({ where: { isActive: true, stockQuantity: { lte: 3 } } }),
        prisma.stockMovement.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: { variant: { include: { product: true } } },
        }),
      ]);

    res.json({
      settings,
      counts: {
        products: productCount,
        variants: variantCount,
        activeVariants,
        prices: priceCount,
        pendingSync,
        failedSync,
        scansToday,
        lowStock,
      },
      lastMovements,
    });
  }),
);
