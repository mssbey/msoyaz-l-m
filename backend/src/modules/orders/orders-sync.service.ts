import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { redis } from '../../lib/redis.js';
import { sentosClient, type SentosOrder, type SentosOrderQuery } from '../sentos/sentos.client.js';
import { formatSentosDate, normalizeOrder, type NormalizedOrder } from './orders.mapper.js';

/**
 * Sentos -> lokal siparis aktarimi (yalnizca OKUMA).
 *
 * Sentos'ta olusan/guncellenen siparisler `GET /orders` ile periyodik cekilir ve
 * `sentos_orders` tablosuna kopyalanir. Sentos'a hicbir istek yazilmaz; stok da
 * degistirilmez (siparis stogu Sentos'ta zaten duser, urun senkronu onu getirir).
 *
 * Artimli calisma: son basarili calismanin zamani imlec olarak saklanir. Her turda
 * imlecten itibaren olusan (created_*) ve guncellenen (updated_*) siparisler istenir;
 * aradaki kayma icin imlec birkac dakika geriden baslatilir. Ilk calismada ya da
 * "tam senkron"da son SENTOS_ORDER_BACKFILL_DAYS gun siparis tarihine gore cekilir.
 */

const KEY = (suffix: string) => `${env.QUEUE_PREFIX}:sentos:${suffix}`;
const LOCK_KEY = KEY('order-sync-lock');
const CURSOR_KEY = KEY('order-sync-cursor');
const STATE_KEY = KEY('order-sync-last');
const OVERLAP_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface OrderSyncResult {
  reason: string;
  mode: 'incremental' | 'full';
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  from?: string;
  to?: string;
  requests: number;
  fetched: number;
  created: number;
  updated: number;
  statusChanged: number;
  unmatchedLines: number;
  skipped: { sentosId: string; reason: string }[];
  error?: string;
}

export async function getLastOrderSync(): Promise<OrderSyncResult | null> {
  const raw = await redis.get(STATE_KEY);
  return raw ? (JSON.parse(raw) as OrderSyncResult) : null;
}

async function saveState(state: OrderSyncResult) {
  await redis.set(STATE_KEY, JSON.stringify(state));
}

type Window = Omit<SentosOrderQuery, 'page' | 'size' | 'orderby_field' | 'orderby_direction'>;

export async function syncOrdersFromSentos(options: { reason?: string; full?: boolean } = {}): Promise<OrderSyncResult> {
  const reason = options.reason ?? 'manual';
  const locked = await redis.set(LOCK_KEY, reason, 'EX', 1800, 'NX');
  if (!locked) {
    logger.info('Sentos siparis senkronu zaten calisiyor, atlandi');
    return (await getLastOrderSync()) ?? emptyState(reason, 'incremental', true);
  }

  const cursorRaw = options.full ? null : await redis.get(CURSOR_KEY);
  const mode: OrderSyncResult['mode'] = cursorRaw ? 'incremental' : 'full';
  const now = new Date();
  const from = cursorRaw
    ? new Date(new Date(cursorRaw).getTime() - OVERLAP_MS)
    : new Date(now.getTime() - env.SENTOS_ORDER_BACKFILL_DAYS * 24 * 3600 * 1000);

  const state = emptyState(reason, mode, true);
  state.from = from.toISOString();
  state.to = now.toISOString();
  await saveState(state);

  const fromText = formatSentosDate(from);
  const toText = formatSentosDate(now);
  const windows: Window[] =
    mode === 'full'
      ? [{ start_date: fromText, end_date: toText }]
      : [
          { created_start_date: fromText, created_end_date: toText },
          { updated_start_date: fromText, updated_end_date: toText },
        ];

  const seen = new Set<number>();
  const variantCache = new Map<string, number | null>();

  try {
    for (const window of windows) {
      await pullWindow(window, state, seen, variantCache);
    }
    // Imlec yalnizca tum pencereler hatasiz bittiginde ilerler.
    await redis.set(CURSOR_KEY, now.toISOString());
  } catch (err) {
    state.error = (err as Error).message;
    logger.error({ err }, 'Sentos siparis senkronu basarisiz');
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.skipped = state.skipped.slice(0, 100);
    await saveState(state);
    await redis.del(LOCK_KEY);
  }

  logger.info(
    { mode, fetched: state.fetched, created: state.created, updated: state.updated, statusChanged: state.statusChanged },
    'Sentos siparis senkronu tamamlandi',
  );
  return state;
}

function emptyState(reason: string, mode: OrderSyncResult['mode'], running: boolean): OrderSyncResult {
  return {
    reason,
    mode,
    startedAt: new Date().toISOString(),
    running,
    requests: 0,
    fetched: 0,
    created: 0,
    updated: 0,
    statusChanged: 0,
    unmatchedLines: 0,
    skipped: [],
  };
}

async function pullWindow(
  window: Window,
  state: OrderSyncResult,
  seen: Set<number>,
  variantCache: Map<string, number | null>,
) {
  const size = env.SENTOS_PAGE_SIZE;
  const pauseMs = Math.ceil(60000 / env.SENTOS_REQUESTS_PER_MINUTE);

  for (let page = 1; ; page += 1) {
    if (state.requests > 0) await sleep(pauseMs);

    const query: SentosOrderQuery = { ...window, page, size, orderby_field: 'id', orderby_direction: 'ASC' };
    let response = await sentosClient.listOrders(query);
    state.requests += 1;

    // Limit asildiysa bir dakika bekleyip ayni sayfayi tekrar dene.
    for (let retry = 0; !response.ok && response.httpStatus === 429 && retry < 3; retry += 1) {
      await sleep(61000);
      response = await sentosClient.listOrders(query);
      state.requests += 1;
    }

    if (!response.ok) {
      throw new Error(`Sentos siparis listesi alinamadi (HTTP ${response.httpStatus ?? 'ag hatasi'}): ${response.error}`);
    }

    const orders = response.data ?? [];
    for (const order of orders) {
      const id = Number(order.id);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      state.fetched += 1;
      await upsertOrder(order, state, variantCache);
    }
    await saveState(state);

    if (orders.length < size) break;
  }
}

async function matchVariant(sku: string | null, barcode: string | null, cache: Map<string, number | null>) {
  const cacheKey = `${sku ?? ''}|${barcode ?? ''}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  const or: Prisma.ProductVariantWhereInput[] = [];
  if (sku) or.push({ sentosStockCode: sku }, { variantCode: sku });
  if (barcode) or.push({ barcode });

  let variantId: number | null = null;
  if (or.length) {
    // Oncelik SKU'da; barkod yalnizca SKU eslesmezse kullanilir.
    const bySku = sku
      ? await prisma.productVariant.findFirst({ where: { OR: or.slice(0, 2) }, select: { id: true } })
      : null;
    const byBarcode = !bySku && barcode
      ? await prisma.productVariant.findFirst({ where: { barcode }, select: { id: true } })
      : null;
    variantId = bySku?.id ?? byBarcode?.id ?? null;
  }

  cache.set(cacheKey, variantId);
  return variantId;
}

async function upsertOrder(remote: SentosOrder, state: OrderSyncResult, variantCache: Map<string, number | null>) {
  let normalized: NormalizedOrder;
  try {
    normalized = normalizeOrder(remote);
  } catch (err) {
    state.skipped.push({ sentosId: String(remote.id), reason: (err as Error).message.slice(0, 160) });
    return;
  }

  const { lines, ...orderData } = normalized;
  const lineRows: (NormalizedOrder['lines'][number] & { variantId: number | null })[] = [];
  for (const line of lines) {
    const variantId = await matchVariant(line.sku, line.barcode, variantCache);
    if (!variantId) state.unmatchedLines += 1;
    lineRows.push({ ...line, variantId });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.sentosOrder.findUnique({
        where: { sentosId: orderData.sentosId },
        select: { id: true, status: true },
      });

      const data = {
        ...orderData,
        shipmentAddress: (orderData.shipmentAddress ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        invoiceAddress: (orderData.invoiceAddress ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        raw: remote as unknown as Prisma.InputJsonValue,
        lastSyncedAt: new Date(),
      };

      let orderId: number;
      if (existing) {
        const statusChanged = existing.status !== orderData.status;
        await tx.sentosOrder.update({
          where: { id: existing.id },
          data: { ...data, ...(statusChanged ? { statusChangedAt: new Date() } : {}) },
        });
        if (statusChanged) state.statusChanged += 1;
        state.updated += 1;
        orderId = existing.id;
        await tx.sentosOrderLine.deleteMany({ where: { orderId } });
      } else {
        const created = await tx.sentosOrder.create({ data: { ...data, statusChangedAt: new Date() } });
        state.created += 1;
        orderId = created.id;
      }

      if (lineRows.length) {
        await tx.sentosOrderLine.createMany({ data: lineRows.map((row) => ({ ...row, orderId })) });
      }
    });
  } catch (err) {
    state.skipped.push({ sentosId: String(remote.id), reason: (err as Error).message.slice(0, 160) });
    logger.warn({ sentosId: remote.id, err: (err as Error).message }, 'Siparis kaydedilemedi');
  }
}
