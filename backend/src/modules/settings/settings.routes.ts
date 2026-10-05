import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../http/middleware/error.js';
import { getSettings, updateSettings } from './settings.service.js';
import { syncUsdRate } from '../exchange/tcmb.service.js';

export const settingsRouter = Router();

const decimalString = z.union([z.number(), z.string()]).refine((v) => Number.isFinite(Number(v)), {
  message: 'Sayisal bir deger olmali.',
});

const updateSchema = z.object({
  pricingModel: z.enum(['EXCEL_MARKUP', 'REVERSE_COMMISSION']).optional(),
  usdExchangeRate: decimalString.optional(),
  targetProfitMarginPercent: decimalString.optional(),
  packagingCost: decimalString.optional(),
  cargoBaremLimit: decimalString.optional(),
  upperBaremCargoCost: decimalString.optional(),
  lowerBaremCargoCost: decimalString.optional(),
  standardCargoCost: decimalString.optional(),
  enYenilerExtraMargin: decimalString.optional(),
  enYenilerDiscountPercent: decimalString.optional(),
  cargoTestBase: decimalString.optional(),
  enYenilerBase: decimalString.optional(),
  priceRoundingStrategy: z.enum(['NONE', 'ROUND_2', 'PSYCHOLOGICAL_99']).optional(),
});

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await getSettings());
  }),
);

/** Ayar guncellemesi fiyati etkiliyorsa toplu yeniden hesaplama otomatik kuyruga girer. */
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = updateSchema.parse(req.body);
    const result = await updateSettings(body);
    res.json(result);
  }),
);

/** TCMB'den kuru elle cekmek icin. */
settingsRouter.post(
  '/exchange-rate/sync',
  asyncHandler(async (_req, res) => {
    const result = await syncUsdRate({ triggerRecalculation: true });
    res.json(result);
  }),
);
