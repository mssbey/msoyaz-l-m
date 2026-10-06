import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { apiKeyAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import { settingsRouter } from '../modules/settings/settings.routes.js';
import { productsRouter, variantsRouter } from '../modules/products/products.routes.js';
import { commissionsRouter } from '../modules/commissions/commissions.routes.js';
import { marketplaceSettingsRouter } from '../modules/commissions/marketplace-settings.routes.js';
import { pricingRouter } from '../modules/pricing/pricing.routes.js';
import { wmsRouter } from '../modules/wms/wms.routes.js';
import { sentosAdminRouter, sentosWebhookRouter } from '../modules/sentos/sentos.routes.js';
import { dashboardRouter } from '../modules/dashboard/dashboard.routes.js';
import { ordersRouter } from '../modules/orders/orders.routes.js';
import { authRouter } from '../modules/auth/auth.routes.js';

export function createApp() {
  const app = express();
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      allowedHeaders: ['Content-Type', 'x-api-key', 'x-operator', 'x-sentos-signature', 'x-mso-client'],
    }),
  );

  // Webhook imzasi icin ham govde saklanir.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  app.get('/health', async (_req, res) => {
    const checks = { database: 'down', redis: 'down' };
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      /* asagida 503 donulur */
    }
    try {
      await redis.ping();
      checks.redis = 'up';
    } catch {
      /* asagida 503 donulur */
    }

    const healthy = checks.database === 'up' && checks.redis === 'up';
    res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', ...checks });
  });

  // Sentos webhook'u imza ile dogrulanir, API anahtari istemez.
  app.use('/api/webhooks/sentos', sentosWebhookRouter);

  // Depo terminali uclari
  app.use('/api/auth', authRouter);
  app.use('/api/wms', apiKeyAuth('TERMINAL'), wmsRouter);

  // Yonetim paneli uclari
  app.use('/api/settings', apiKeyAuth('ADMIN'), settingsRouter);
  app.use('/api/products', apiKeyAuth('ADMIN'), productsRouter);
  app.use('/api/variants', apiKeyAuth('ADMIN'), variantsRouter);
  app.use('/api/commissions', apiKeyAuth('ADMIN'), commissionsRouter);
  app.use('/api/marketplace-settings', apiKeyAuth('ADMIN'), marketplaceSettingsRouter);
  app.use('/api/pricing', apiKeyAuth('ADMIN'), pricingRouter);
  app.use('/api/sentos', apiKeyAuth('ADMIN'), sentosAdminRouter);
  app.use('/api/dashboard', apiKeyAuth('ADMIN'), dashboardRouter);
  app.use('/api/orders', apiKeyAuth('ADMIN'), ordersRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
