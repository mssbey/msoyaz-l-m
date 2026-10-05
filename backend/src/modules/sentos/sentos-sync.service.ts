import { Prisma, StockMovementType } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { getSettings } from '../settings/settings.service.js';
import { SENTOS_READ_ONLY, SentosClient, sentosClient, type SentosProduct, type SentosVariant } from './sentos.client.js';
import {
  applyStockDelta,
  normalizeStocks,
  toSentosStocks,
  totalStock,
  type WarehouseStock,
} from './sentos.mapper.js';

/**
 * Sentos <-> lokal stok modeli
 *
 * Stogun tek dogru kaynagi Sentos'tur (pazar yeri satislari orada dusulur).
 * Lokal `stock_quantity`, Sentos'taki toplam stok + henuz iletilmemis okutmalardir:
 *
 *     stock_quantity = sentos_toplam + pending_sentos_delta
 *
 * Okutma: stock_quantity ve pending_sentos_delta ayni transaction'da azalir.
 * Aktarim: Sentos'tan guncel stok okunur, bekleyen fark uygulanir, PUT edilir
 * ve uygulanan kadar pending_sentos_delta geri alinir. Mutlak deger gonderilmedigi
 * icin arada pazar yerinden gelen satislar ezilmez.
 */

const KEY = (suffix: string) => `${env.QUEUE_PREFIX}:sentos:${suffix}`;
const SYNC_LOCK_KEY = KEY('product-sync-lock');
const LAST_SYNC_KEY = KEY('product-sync-last');
/** Sentos ayni GET istegini dakikada 2 kez kabul eder. */
const SAME_GET_INTERVAL_SECONDS = 31;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ProductSyncResult {
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  pages: number;
  products: number;
  variantsCreated: number;
  variantsUpdated: number;
  stockChanged: number;
  skipped: { sku: string; reason: string }[];
  error?: string;
}

async function saveSyncState(state: ProductSyncResult) {
  await redis.set(LAST_SYNC_KEY, JSON.stringify(state));
}

export async function getLastProductSync(): Promise<ProductSyncResult | null> {
  const raw = await redis.get(LAST_SYNC_KEY);
  return raw ? (JSON.parse(raw) as ProductSyncResult) : null;
}

/** Varyasyonsuz urunlerde urunun kendisi tek varyant gibi ele alinir. */
function variantsOf(product: SentosProduct): (SentosVariant & { isSimple: boolean })[] {
  if (Array.isArray(product.variants) && product.variants.length > 0) {
    return product.variants.map((variant) => ({ ...variant, isSimple: false }));
  }
  return [{ sku: product.sku, barcode: product.barcode, stocks: product.stocks, isSimple: true }];
}

function firstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  const first = images[0] as { url?: string } | string;
  return typeof first === 'string' ? first : first?.url ?? null;
}

/**
 * Sentos'taki tum urun ve varyantlari lokal veritabanina aktarir.
 * Eslestirme sirasi: Sentos urun ID -> ana urun kodu (SKU); varyantta SKU -> barkod.
 * Maliyet / komisyon gibi fiyatlama alanlarina dokunulmaz.
 */
export async function syncProductsFromSentos(reason = 'manual'): Promise<ProductSyncResult> {
  const locked = await redis.set(SYNC_LOCK_KEY, reason, 'EX', 1800, 'NX');
  if (!locked) {
    const last = await getLastProductSync();
    logger.info('Sentos urun senkronu zaten calisiyor, atlandi');
    return last ?? { startedAt: new Date().toISOString(), running: true, pages: 0, products: 0, variantsCreated: 0, variantsUpdated: 0, stockChanged: 0, skipped: [] };
  }

  const state: ProductSyncResult = {
    startedAt: new Date().toISOString(),
    running: true,
    pages: 0,
    products: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    stockChanged: 0,
    skipped: [],
  };
  await saveSyncState(state);

  const pageSize = env.SENTOS_PAGE_SIZE;
  const pauseMs = Math.ceil(60000 / env.SENTOS_REQUESTS_PER_MINUTE);

  try {
    // Terminalde depo adlarinin gosterilebilmesi icin depo listesi de tazelenir.
    await getWarehouses(true).catch((err) => logger.warn({ err: (err as Error).message }, 'Depo listesi alinamadi'));

    for (let page = 1; ; page += 1) {
      let response = await sentosClient.listProducts(page, pageSize);

      // Limit asildiysa bir dakika bekleyip ayni sayfayi tekrar dene.
      for (let retry = 0; !response.ok && response.httpStatus === 429 && retry < 3; retry += 1) {
        await sleep(61000);
        response = await sentosClient.listProducts(page, pageSize);
      }

      if (!response.ok) {
        throw new Error(`Sentos urun listesi alinamadi (HTTP ${response.httpStatus ?? 'ag hatasi'}): ${response.error}`);
      }

      const products = response.data ?? [];
      state.pages = page;

      for (const product of products) {
        await upsertSentosProduct(product, state);
        state.products += 1;
      }
      await saveSyncState(state);

      if (products.length < pageSize) break;
      await sleep(pauseMs);
    }
  } catch (err) {
    state.error = (err as Error).message;
    logger.error({ err }, 'Sentos urun senkronu basarisiz');
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.skipped = state.skipped.slice(0, 200);
    await saveSyncState(state);
    await redis.del(SYNC_LOCK_KEY);
  }

  logger.info(
    { products: state.products, created: state.variantsCreated, updated: state.variantsUpdated, stockChanged: state.stockChanged },
    'Sentos urun senkronu tamamlandi',
  );
  return state;
}

async function upsertSentosProduct(remote: SentosProduct, state: ProductSyncResult) {
  const mainProductCode = remote.sku?.trim() || `SENTOS-${remote.id}`;
  const productData = {
    name: remote.name?.trim() || mainProductCode,
    brand: remote.brand ?? null,
    category: remote.category_id != null ? String(remote.category_id) : null,
    imageUrl: firstImageUrl(remote.images),
    sentosProductId: remote.id,
    sentosSyncedAt: new Date(),
  };

  const existing =
    (await prisma.product.findUnique({ where: { sentosProductId: remote.id } })) ??
    (await prisma.product.findFirst({ where: { mainProductCode, sentosProductId: null } }));

  let product;
  try {
    product = existing
      ? await prisma.product.update({ where: { id: existing.id }, data: productData })
      : await prisma.product.create({ data: { mainProductCode, ...productData } });
  } catch (err) {
    state.skipped.push({ sku: mainProductCode, reason: `Urun kaydedilemedi: ${(err as Error).message.slice(0, 160)}` });
    return;
  }

  for (const variant of variantsOf(remote)) {
    const sku = variant.sku?.trim();
    if (!sku) {
      state.skipped.push({ sku: `${mainProductCode} (#${remote.id})`, reason: 'Varyant SKU bos' });
      continue;
    }

    const barcode = variant.barcode ? String(variant.barcode).trim() : '';
    const stocks = normalizeStocks(variant.stocks);
    const remoteTotal = totalStock(stocks);

    const match = await prisma.productVariant.findFirst({
      where: {
        OR: [
          { sentosProductId: remote.id, sentosStockCode: sku },
          { sentosStockCode: sku },
          { variantCode: sku },
          ...(barcode ? [{ barcode }] : []),
        ],
      },
    });

    const data = {
      productId: product.id,
      sentosProductId: remote.id,
      sentosStockCode: sku,
      color: variant.color ?? null,
      size: variant.model?.value ?? null,
      model: variant.model?.name ?? null,
      warehouseStocks: stocks as unknown as Prisma.InputJsonValue,
      imageUrl: firstImageUrl(variant.images) ?? productData.imageUrl,
      sentosSyncedAt: new Date(),
      isActive: true,
    };

    try {
      if (!match) {
        await prisma.productVariant.create({
          data: { ...data, variantCode: sku, barcode: barcode || sku, stockQuantity: remoteTotal },
        });
        state.variantsCreated += 1;
        continue;
      }

      await prisma.productVariant.update({
        where: { id: match.id },
        data: { ...data, ...(barcode && barcode !== match.barcode ? { barcode } : {}) },
      });

      // Tek ifadeyle guncellenir: arada gelen okutmanin pending farki kaybolmaz.
      const [after] = await prisma.$queryRaw<{ stock_quantity: number; pending_sentos_delta: number }[]>`
        UPDATE product_variants
           SET stock_quantity = GREATEST(0, ${remoteTotal}::int + pending_sentos_delta)
         WHERE id = ${match.id}
     RETURNING stock_quantity, pending_sentos_delta`;

      state.variantsUpdated += 1;

      if (after && after.stock_quantity !== match.stockQuantity) {
        state.stockChanged += 1;
        await prisma.stockMovement.create({
          data: {
            variantId: match.id,
            type: StockMovementType.SYNC_CORRECTION,
            quantityChange: after.stock_quantity - match.stockQuantity,
            quantityAfter: after.stock_quantity,
            reference: 'sentos-sync',
            note: `Sentos stogu: ${remoteTotal}${after.pending_sentos_delta ? `, iletilmeyi bekleyen: ${after.pending_sentos_delta}` : ''}`,
          },
        });
      }
    } catch (err) {
      const message =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
          ? `Barkod/SKU baska bir varyantta kayitli (${barcode || sku})`
          : (err as Error).message.slice(0, 160);
      state.skipped.push({ sku, reason: message });
    }
  }
}

/**
 * Bir urunun bekleyen stok farklarini Sentos'a iletir (kuyruk worker'i cagirir).
 * GET ile guncel stok okunur, fark uygulanir, tum varyantlar PUT ile geri yazilir.
 */
export async function flushProductStock(productId: number, attempt = 1) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: true },
  });
  if (!product?.sentosProductId) return { skipped: true, reason: 'sentos_eslesmesi_yok' };

  const pending = product.variants.filter((v) => v.pendingSentosDelta !== 0 && !v.lastSentosError);
  if (pending.length === 0) return { skipped: true, reason: 'bekleyen_yok' };

  // Salt okunur: okutmalar Sentos'a yazilmaz. Bekleyen fark temizlenir; lokal stok bir
  // sonraki urun senkronunda Sentos'taki degere doner (Sentos dogru kaynaktir).
  if (SENTOS_READ_ONLY) {
    for (const variant of pending) {
      await prisma.$executeRaw`
        UPDATE product_variants
           SET pending_sentos_delta = pending_sentos_delta - ${variant.pendingSentosDelta}::int
         WHERE id = ${variant.id}`;
    }
    return { skipped: true, reason: 'salt_okunur', variants: pending.length };
  }

  const sentosId = product.sentosProductId;

  // Ayni urun icin GET dakikada 2 kez sinirli: gerekirse kalan sure beklenir.
  const throttleKey = KEY(`get:${sentosId}`);
  const ttl = await redis.ttl(throttleKey);
  if (ttl > 0) await sleep(ttl * 1000);
  await redis.set(throttleKey, '1', 'EX', SAME_GET_INTERVAL_SECONDS);

  const remoteResult = await sentosClient.getProduct(sentosId, attempt);
  if (!remoteResult.ok || !remoteResult.data) {
    if (SentosClient.isRetryable(remoteResult)) {
      throw new Error(`Sentos urunu okunamadi (${remoteResult.httpStatus ?? 'ag'}): ${remoteResult.error}`);
    }
    await markVariantsFailed(pending.map((v) => v.id), `Sentos urunu okunamadi: ${remoteResult.error ?? 'bos yanit'}`);
    return { ok: false, error: remoteResult.error };
  }

  const remote = remoteResult.data;
  const settings = await getSettings();
  const preferredWarehouse = settings.sentosWarehouseId;
  const remoteVariants = variantsOf(remote);
  const isSimple = remoteVariants[0]?.isSimple === true;

  const applied = new Map<number, { applied: number; stocks: WarehouseStock[] }>();
  const notFound: number[] = [];

  const updatedRemote = remoteVariants.map((remoteVariant) => {
    const local = pending.find((v) => v.sentosStockCode === remoteVariant.sku || v.variantCode === remoteVariant.sku);
    const stocks = normalizeStocks(remoteVariant.stocks);
    if (!local) return { remoteVariant, stocks };

    const result = applyStockDelta(stocks, local.pendingSentosDelta, preferredWarehouse);
    applied.set(local.id, { applied: local.pendingSentosDelta, stocks: result.stocks });
    if (result.applied !== local.pendingSentosDelta) {
      logger.warn({ sku: remoteVariant.sku, wanted: local.pendingSentosDelta, applied: result.applied }, 'Sentos stogu yetersiz, sifira cekildi');
    }
    return { remoteVariant, stocks: result.stocks };
  });

  for (const local of pending) if (!applied.has(local.id)) notFound.push(local.id);
  if (notFound.length) await markVariantsFailed(notFound, "Varyant SKU'su Sentos urununde bulunamadi");
  if (applied.size === 0) return { ok: false, error: 'eslesen_varyant_yok' };

  // Varyantlar eksiksiz geri gonderilir; PUT'un listede olmayan varyantlari silme riski olmaz.
  const body = isSimple
    ? { stocks: toSentosStocks(updatedRemote[0]?.stocks ?? []) }
    : {
        variants: updatedRemote.map(({ remoteVariant, stocks }) => {
          const { isSimple: _omit, ...rest } = remoteVariant;
          return { ...rest, stocks: toSentosStocks(stocks) };
        }),
      };

  const putResult = await sentosClient.updateProduct(sentosId, body, attempt);

  if (!putResult.ok) {
    if (SentosClient.isRetryable(putResult)) {
      throw new Error(`Sentos stok guncellemesi gecici hata (${putResult.httpStatus ?? 'ag'}): ${putResult.error}`);
    }
    await markVariantsFailed([...applied.keys()], `Sentos stok guncellemesi reddedildi (HTTP ${putResult.httpStatus}): ${putResult.error}`);
    return { ok: false, error: putResult.error };
  }

  for (const [variantId, { applied: delta, stocks }] of applied) {
    const newTotal = totalStock(stocks);
    const stocksJson = JSON.stringify(stocks);

    if (putResult.dryRun) {
      // Deneme modu: Sentos degismedi, lokal stok oldugu gibi kalir; bekleyen fark temizlenir.
      await prisma.$executeRaw`
        UPDATE product_variants
           SET pending_sentos_delta = pending_sentos_delta - ${delta}::int,
               sentos_synced_at = NOW(), last_sentos_error = NULL
         WHERE id = ${variantId}`;
      continue;
    }

    // Postgres SET ifadeleri eski satir degerlerini kullanir: arada gelen okutmalar korunur.
    await prisma.$executeRaw`
      UPDATE product_variants
         SET stock_quantity = GREATEST(0, ${newTotal}::int + pending_sentos_delta - ${delta}::int),
             pending_sentos_delta = pending_sentos_delta - ${delta}::int,
             warehouse_stocks = ${stocksJson}::jsonb,
             sentos_synced_at = NOW(),
             last_sentos_error = NULL
       WHERE id = ${variantId}`;
  }

  return {
    ok: true,
    dryRun: putResult.dryRun,
    sentosProductId: sentosId,
    variants: [...applied.entries()].map(([id, v]) => ({ id, delta: v.applied, total: totalStock(v.stocks) })),
  };
}

async function markVariantsFailed(variantIds: number[], error: string) {
  await prisma.productVariant.updateMany({
    where: { id: { in: variantIds } },
    data: { lastSentosError: error.slice(0, 1000) },
  });
  logger.error({ variantIds, error }, 'Sentos stok aktarimi basarisiz');
}

/** Sentos'a iletilmeyi bekleyen stok farki olan urunler. */
export async function findProductsWithPendingStock() {
  const rows = await prisma.productVariant.findMany({
    where: { pendingSentosDelta: { not: 0 }, lastSentosError: null, sentosProductId: { not: null } },
    select: { productId: true },
    distinct: ['productId'],
  });
  return rows.map((row) => row.productId);
}

/** Hatali isaretlenen aktarimlari tekrar denemeye acar. */
export async function resetFailedStockPushes() {
  const result = await prisma.productVariant.updateMany({
    where: { lastSentosError: { not: null }, pendingSentosDelta: { not: 0 } },
    data: { lastSentosError: null },
  });
  return result.count;
}

export async function sentosStatus() {
  const [pendingVariants, failedVariants, linkedVariants, totalVariants, lastSync, settings] = await Promise.all([
    prisma.productVariant.count({ where: { pendingSentosDelta: { not: 0 }, lastSentosError: null } }),
    prisma.productVariant.findMany({
      where: { lastSentosError: { not: null }, pendingSentosDelta: { not: 0 } },
      include: { product: { select: { name: true } } },
      take: 50,
    }),
    prisma.productVariant.count({ where: { sentosProductId: { not: null } } }),
    prisma.productVariant.count(),
    getLastProductSync(),
    getSettings(),
  ]);

  return {
    configured: sentosClient.isConfigured,
    dryRun: env.SENTOS_DRY_RUN,
    readOnly: SENTOS_READ_ONLY,
    baseUrl: env.SENTOS_BASE_URL,
    requestsPerMinute: env.SENTOS_REQUESTS_PER_MINUTE,
    warehouseId: settings.sentosWarehouseId,
    pendingVariants,
    failed: failedVariants.map((v) => ({
      id: v.id,
      variantCode: v.variantCode,
      name: v.product.name,
      pendingSentosDelta: v.pendingSentosDelta,
      error: v.lastSentosError,
    })),
    linkedVariants,
    totalVariants,
    lastSync,
  };
}

const WAREHOUSES_KEY = KEY('warehouses');

/** Sentos depo listesi (1 saat onbellekli; Sentos GET limitine takilmamak icin). */
export async function getWarehouses(refresh = false) {
  if (!refresh) {
    const cached = await redis.get(WAREHOUSES_KEY);
    if (cached) return JSON.parse(cached) as { id: number; name: string }[];
  }
  const result = await sentosClient.listWarehouses();
  if (!result.ok) throw new Error(`Sentos depolari alinamadi: ${result.error}`);
  const warehouses = (result.data ?? []).map((w) => ({ id: Number(w.id), name: String(w.name) }));
  await redis.set(WAREHOUSES_KEY, JSON.stringify(warehouses), 'EX', 3600);
  return warehouses;
}

/** Terminal icin: onbellekte yoksa bos liste doner, Sentos'a istek atmaz. */
export async function getCachedWarehouses() {
  const cached = await redis.get(WAREHOUSES_KEY);
  return cached ? (JSON.parse(cached) as { id: number; name: string }[]) : [];
}
