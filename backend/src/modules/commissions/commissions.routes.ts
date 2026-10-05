import { Router } from 'express';
import { Marketplace } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../http/middleware/error.js';
import { enqueueFullRecalculation } from '../../queues/producers.js';

export const commissionsRouter = Router();

const commissionSchema = z.object({
  marketplace: z.nativeEnum(Marketplace),
  categoryId: z.string().min(1).default('*'),
  commissionPercent: z.union([z.number(), z.string()]),
  extraCommissionPercent: z.union([z.number(), z.string()]).default(0),
  isActive: z.boolean().default(true),
});

commissionsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await prisma.marketplaceCommission.findMany({
      orderBy: [{ marketplace: 'asc' }, { categoryId: 'asc' }],
    });
    res.json({ items });
  }),
);

/** Komisyon degisimi tum fiyatlari etkiler; kayittan sonra yeniden hesaplama kuyruga girer. */
commissionsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = commissionSchema.parse(req.body);
    const row = await prisma.marketplaceCommission.upsert({
      where: { marketplace_categoryId: { marketplace: data.marketplace, categoryId: data.categoryId } },
      create: data,
      update: data,
    });
    await enqueueFullRecalculation({ reason: `commission_changed:${data.marketplace}/${data.categoryId}` });
    res.status(201).json(row);
  }),
);

commissionsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = commissionSchema.partial().parse(req.body);
    const row = await prisma.marketplaceCommission.update({ where: { id: Number(req.params.id) }, data });
    await enqueueFullRecalculation({ reason: `commission_changed:${row.marketplace}/${row.categoryId}` });
    res.json(row);
  }),
);

commissionsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const row = await prisma.marketplaceCommission.delete({ where: { id: Number(req.params.id) } });
    await enqueueFullRecalculation({ reason: `commission_deleted:${row.marketplace}/${row.categoryId}` });
    res.json({ deleted: true, id: row.id });
  }),
);
