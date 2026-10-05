import type { Marketplace, ProductVariant, VariantPrice } from '@prisma/client';
import type { SentosPriceItem, SentosStockEntry } from './sentos.client.js';

/**
 * Excel'deki "MSO to Sentos Transfer" sayfasinin JSON karsiligi.
 * Sentos'un bekledigi pazar yeri kodlari burada eslesir.
 */
export const MARKETPLACE_CODES: Record<Marketplace, string> = {
  N11: 'n11',
  HB: 'hepsiburada',
  TY: 'trendyol',
  PZRM: 'pazarama',
  STD: 'standart',
  ENY: 'enyeniler',
};

export interface PriceRow extends VariantPrice {
  variant: ProductVariant;
}

export function toSentosPriceItem(row: PriceRow): SentosPriceItem {
  return {
    stockCode: row.variant.sentosStockCode ?? row.variant.variantCode,
    marketplace: MARKETPLACE_CODES[row.marketplace],
    salePrice: Number(row.salePrice),
    // TY / PZRM'de ustu cizili liste fiyati; yoksa satis fiyatinin kendisi gonderilir.
    listPrice: row.marketPrice ? Number(row.marketPrice) : Number(row.salePrice),
    currency: 'TRY',
  };
}

/** Lokalde saklanan depo bazli stok satiri. */
export interface WarehouseStock {
  warehouseId: number;
  stock: number;
}

/** Sentos stok satirlarini { warehouseId, stock } bicimine cevirir. */
export function normalizeStocks(entries: SentosStockEntry[] | undefined | null): WarehouseStock[] {
  if (!Array.isArray(entries)) return [];
  const result: WarehouseStock[] = [];
  for (const entry of entries) {
    const raw = typeof entry.warehouse === 'object' && entry.warehouse !== null ? entry.warehouse.id : entry.warehouse;
    const warehouseId = Number(raw);
    const stock = Math.trunc(Number(String(entry.stock ?? 0).replace(',', '.')));
    if (!Number.isFinite(warehouseId)) continue;
    result.push({ warehouseId, stock: Number.isFinite(stock) ? stock : 0 });
  }
  return result;
}

export function totalStock(stocks: WarehouseStock[]): number {
  return stocks.reduce((sum, row) => sum + Math.max(0, row.stock), 0);
}

/**
 * Stok farkini depolara dagitir. Dusus once tercih edilen depodan, yetmezse
 * en cok stogu olan diger depolardan yapilir ("tum stoktan dus"). Artis tercih
 * edilen depoya eklenir. Toplam stok sifirin altina inmez.
 */
export function applyStockDelta(
  stocks: WarehouseStock[],
  delta: number,
  preferredWarehouseId?: number | null,
): { stocks: WarehouseStock[]; applied: number } {
  const next = stocks.map((row) => ({ ...row }));
  const preferredId = preferredWarehouseId ?? next[0]?.warehouseId ?? 1;

  let preferred = next.find((row) => row.warehouseId === preferredId);
  if (!preferred) {
    preferred = { warehouseId: preferredId, stock: 0 };
    next.unshift(preferred);
  }

  if (delta >= 0) {
    preferred.stock += delta;
    return { stocks: next, applied: delta };
  }

  let remaining = -delta;
  const order = [preferred, ...next.filter((row) => row !== preferred).sort((a, b) => b.stock - a.stock)];
  for (const row of order) {
    if (remaining === 0) break;
    const take = Math.min(Math.max(0, row.stock), remaining);
    row.stock -= take;
    remaining -= take;
  }

  return { stocks: next, applied: delta + remaining };
}

/** Sentos PUT govdesindeki stok satiri bicimi. */
export function toSentosStocks(stocks: WarehouseStock[]) {
  return stocks.map((row) => ({ warehouse: row.warehouseId, stock: row.stock }));
}

/** Sentos siparis webhook'undaki satirlarin normalize edilmis hali. */
export interface NormalizedOrderLine {
  stockCode: string;
  quantity: number;
}

export interface NormalizedOrderWebhook {
  orderId: string;
  eventType: string;
  lines: NormalizedOrderLine[];
}

interface RawWebhookBody {
  event?: string;
  eventType?: string;
  orderId?: string | number;
  order_id?: string | number;
  id?: string | number;
  order?: { id?: string | number; items?: unknown[]; lines?: unknown[] };
  items?: unknown[];
  lines?: unknown[];
  products?: unknown[];
}

interface RawLine {
  stockCode?: string;
  stock_code?: string;
  sku?: string;
  barcode?: string;
  productCode?: string;
  quantity?: number | string;
  qty?: number | string;
  adet?: number | string;
}

/**
 * Sentos farkli event tiplerinde farkli alan adlari kullanabildigi icin
 * gelen govde tolere edilerek normalize edilir.
 */
export function normalizeOrderWebhook(body: unknown): NormalizedOrderWebhook {
  const raw = (body ?? {}) as RawWebhookBody;

  const orderId = String(raw.orderId ?? raw.order_id ?? raw.order?.id ?? raw.id ?? '');
  if (!orderId) {
    throw new Error('Webhook govdesinde siparis numarasi (orderId) bulunamadi.');
  }

  const rawLines = (raw.items ?? raw.lines ?? raw.products ?? raw.order?.items ?? raw.order?.lines ?? []) as RawLine[];

  const lines: NormalizedOrderLine[] = [];
  for (const line of rawLines) {
    const stockCode = line.stockCode ?? line.stock_code ?? line.sku ?? line.productCode ?? line.barcode;
    const quantityRaw = line.quantity ?? line.qty ?? line.adet ?? 1;
    const quantity = Number(quantityRaw);

    if (!stockCode || !Number.isFinite(quantity) || quantity <= 0) continue;
    lines.push({ stockCode: String(stockCode), quantity: Math.trunc(quantity) });
  }

  return {
    orderId,
    eventType: String(raw.eventType ?? raw.event ?? 'order.created'),
    lines,
  };
}
