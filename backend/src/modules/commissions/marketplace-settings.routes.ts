import { Router } from 'express';
import { Marketplace } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler } from '../../http/middleware/error.js';
import { enqueueFullRecalculation } from '../../queues/producers.js';

export const marketplaceSettingsRouter = Router();

const numeric = z.union([z.number(), z.string()]);

const schema = z.object({
  marketplace: z.nativeEnum(Marketplace),
  cargoBaremLimit: numeric.optional(),
  extraFarkPercent: numeric.optional(),
  marketPriceMarkupPercent: numeric.optional(),
  usesCargo: z.boolean().optional(),
  usesCommission: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

marketplaceSettingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await prisma.marketplaceSetting.findMany({ orderBy: { marketplace: 'asc' } });
    res.json({ items });
  }),
);

/** Barem / extra fark / piyasa carpani degisimi tum fiyatlari etkiler. */
marketplaceSettingsRouter.put(
  '/:marketplace',
  asyncHandler(async (req, res) => {
    const marketplace = z.nativeEnum(Marketplace).parse(req.params.marketplace);
    const data = schema.partial().parse({ ...req.body, marketplace });
    const { marketplace: _ignored, ...values } = data;

    const row = await prisma.marketplaceSetting.upsert({
      where: { marketplace },
      create: { marketplace, ...values },
      update: values,
    });

    await enqueueFullRecalculation({ reason: `marketplace_settings_changed:${marketplace}` });
    res.json(row);
  }),
);
