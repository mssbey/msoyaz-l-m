import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),

  ADMIN_API_KEY: z.string().min(1),
  TERMINAL_API_KEY: z.string().min(1),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD_HASH: z.string().default(''),
  SESSION_HOURS: z.coerce.number().min(1).max(168).default(12),
  CORS_ORIGIN: z.string().default('*'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6381'),
  QUEUE_PREFIX: z.string().default('mso'),

  SENTOS_BASE_URL: z.string().default('https://api.sentos.com.tr'),
  SENTOS_API_KEY: z.string().optional().default(''),
  SENTOS_API_SECRET: z.string().optional().default(''),
  SENTOS_WEBHOOK_SECRET: z.string().optional().default(''),
  SENTOS_RATE_LIMIT_PER_SECOND: z.coerce.number().default(5),
  SENTOS_CHUNK_SIZE: z.coerce.number().default(50),
  SENTOS_TIMEOUT_MS: z.coerce.number().default(20000),
  SENTOS_DRY_RUN: bool,
  /// Sentos limiti POST 12/dk; stok yazimlari bu sinirin altinda tutulur.
  SENTOS_REQUESTS_PER_MINUTE: z.coerce.number().min(1).default(10),
  SENTOS_PAGE_SIZE: z.coerce.number().min(1).max(500).default(100),
  /// Art arda okutmalarin tek istekte birlestirilmesi icin bekleme suresi
  SENTOS_STOCK_DEBOUNCE_MS: z.coerce.number().min(0).default(3000),
  /// Fiyat aktarimi Sentos'un gercek fiyat uclarina baglanana kadar kapali tutulur.
  SENTOS_PRICE_PUSH_ENABLED: bool,
  /// Ilk siparis senkronunda (ve "tam senkron"da) geriye dogru kac gun okunur
  SENTOS_ORDER_BACKFILL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  TCMB_URL: z.string().default('https://www.tcmb.gov.tr/kurlar/today.xml'),

  CRON_ENABLED: bool,
  TZ: z.string().default('Europe/Istanbul'),
  CRON_FX_UPDATE: z.string().default('0 3 * * *'),
  CRON_PRICE_RECALC: z.string().default('10 3 * * *'),
  CRON_PRICE_PUSH: z.string().default('30 3 * * *'),
  CRON_STOCK_CHECK: z.string().default('*/15 * * * *'),
  CRON_STOCK_FLUSH: z.string().default('* * * * *'),
  CRON_ORDER_SYNC: z.string().default('*/2 * * * *'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Uygulama eksik/yanlis config ile ayaga kalkmamali.
  console.error('Gecersiz ortam degiskenleri:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
