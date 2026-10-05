import { Prisma, StockMovementType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { enqueueProductStockFlush } from '../../queues/producers.js';

export class WmsError extends Error {
  constructor(
    message: string,
    public code:
      | 'BARCODE_NOT_FOUND'
      | 'OUT_OF_STOCK'
      | 'VARIANT_INACTIVE'
      | 'INVALID_QUANTITY'
      | 'BARCODE_MISMATCH' = 'BARCODE_NOT_FOUND',
  ) {
    super(message);
    this.name = 'WmsError';
  }
}

const variantInclude = { product: true } satisfies Prisma.ProductVariantInclude;

export async function findByBarcode(code: string) {
  const trimmed = code.trim();
  if (!trimmed) throw new WmsError('Barkod bos olamaz.');

  // Barkod okuyucu bazen varyant kodunu da gonderebilir; ikisi de denenir.
  const variant = await prisma.productVariant.findFirst({
    where: {
      OR: [{ barcode: trimmed }, { variantCode: trimmed }, { sentosStockCode: trimmed }],
    },
    include: variantInclude,
  });

  if (!variant) throw new WmsError(`Barkod bulunamadi: ${trimmed}`, 'BARCODE_NOT_FOUND');
  return variant;
}

export interface ScanOutInput {
  barcode: string;
  operator?: string;
  quantity?: number;
  reference?: string;
  /** Terminalde urun secildiyse okutulan barkodun o urune ait olmasi zorunludur. */
  expectedVariantId?: number;
}

/**
 * Depo cikisi: raftan alinan urunun barkodu okutulur.
 *
 * Stok dususu ve hareket kaydi tek transaction icinde yapilir; ayni anda
 * calisan iki terminalin stogu eksiye dusurmesi kosullu update ile engellenir.
 *
 * Rezervasyon notu: siparis webhook'u geldiginde reserved_quantity artar
 * (satilabilir stok = stock_quantity - reserved_quantity). Raftan okutuldugunda
 * fiziksel stok duser ve varsa rezervasyon tuketilir; boylece ayni siparis
 * iki kez dusulmez.
 */
export async function scanOut(input: ScanOutInput) {
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new WmsError('Adet pozitif tam sayi olmalidir.', 'INVALID_QUANTITY');
  }

  const variant = await findByBarcode(input.barcode);
  if (input.expectedVariantId && variant.id !== input.expectedVariantId) {
    throw new WmsError(
      `Yanlis urun! Okutulan: ${variant.product.name} (${variant.variantCode}). Secili urunun barkodunu okutun.`,
      'BARCODE_MISMATCH',
    );
  }
  if (!variant.isActive) {
    throw new WmsError(`Varyant pasif durumda: ${variant.variantCode}`, 'VARIANT_INACTIVE');
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.productVariant.updateMany({
      where: { id: variant.id, stockQuantity: { gte: quantity } },
      data: {
        stockQuantity: { decrement: quantity },
        // Rezervasyon varsa tuketilir; yoksa 0'in altina inmemesi icin asagida duzeltilir.
        reservedQuantity: { decrement: quantity },
        // Sentos'a iletilecek fark: aktarim isi bunu guncel Sentos stogundan duser.
        ...(variant.sentosProductId ? { pendingSentosDelta: { decrement: quantity } } : {}),
      },
    });

    if (updated.count === 0) {
      throw new WmsError(
        `Yetersiz stok: ${variant.variantCode} (mevcut: ${variant.stockQuantity})`,
        'OUT_OF_STOCK',
      );
    }

    // reservedQuantity negatife dustuyse sifirla (rezervasyonsuz cikis).
    await tx.productVariant.updateMany({
      where: { id: variant.id, reservedQuantity: { lt: 0 } },
      data: { reservedQuantity: 0 },
    });

    const fresh = await tx.productVariant.findUniqueOrThrow({
      where: { id: variant.id },
      include: variantInclude,
    });

    await tx.stockMovement.create({
      data: {
        variantId: variant.id,
        type: StockMovementType.WAREHOUSE_SCAN,
        quantityChange: -quantity,
        quantityAfter: fresh.stockQuantity,
        reference: input.reference ?? input.barcode,
        operator: input.operator ?? null,
      },
    });

    return fresh;
  });

  // Sentos'a aktarim kuyruga alinir (kisa bir bekleme ile art arda okutmalar birlesir).
  if (variant.sentosProductId) {
    await enqueueProductStockFlush({ productId: variant.productId, reason: 'warehouse_scan' });
  }

  return result;
}

export interface AdjustStockInput {
  variantId: number;
  newQuantity: number;
  operator?: string;
  note?: string;
  type?: StockMovementType;
}

/** Panelden elle stok duzeltme / mal kabul. */
export async function adjustStock(input: AdjustStockInput) {
  if (!Number.isInteger(input.newQuantity) || input.newQuantity < 0) {
    throw new WmsError('Stok adedi 0 veya pozitif tam sayi olmalidir.', 'INVALID_QUANTITY');
  }

  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.productVariant.findUnique({ where: { id: input.variantId } });
    if (!current) throw new WmsError(`Varyant bulunamadi: ${input.variantId}`);

    const change = input.newQuantity - current.stockQuantity;

    const fresh = await tx.productVariant.update({
      where: { id: input.variantId },
      data: {
        stockQuantity: input.newQuantity,
        ...(current.sentosProductId ? { pendingSentosDelta: { increment: change } } : {}),
      },
      include: variantInclude,
    });

    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        type: input.type ?? StockMovementType.MANUAL_ADJUST,
        quantityChange: change,
        quantityAfter: input.newQuantity,
        operator: input.operator ?? null,
        note: input.note ?? null,
      },
    });

    return fresh;
  });

  if (updated.sentosProductId) {
    await enqueueProductStockFlush({ productId: updated.productId, reason: 'manual_adjust' });
  }
  return updated;
}

export interface ReserveLine {
  stockCode: string;
  quantity: number;
}

export interface ReserveResult {
  reserved: { variantId: number; stockCode: string; quantity: number; availableAfter: number }[];
  notFound: string[];
}

/**
 * Siparis webhook'u: fiziksel stok raftan dusmeden once dijital rezervasyon yapilir.
 * Satilabilir stok (stock_quantity - reserved_quantity) aninda azalir ve
 * pazar yerlerine yeni deger gonderilir.
 */
export async function reserveForOrder(lines: ReserveLine[], orderId: string): Promise<ReserveResult> {
  const reserved: ReserveResult['reserved'] = [];
  const notFound: string[] = [];

  for (const line of lines) {
    const variant = await prisma.productVariant.findFirst({
      where: {
        OR: [{ sentosStockCode: line.stockCode }, { variantCode: line.stockCode }, { barcode: line.stockCode }],
      },
    });

    if (!variant) {
      notFound.push(line.stockCode);
      logger.warn({ stockCode: line.stockCode, orderId }, 'Webhook: stok kodu eslesmedi');
      continue;
    }

    const fresh = await prisma.$transaction(async (tx) => {
      const updatedVariant = await tx.productVariant.update({
        where: { id: variant.id },
        data: { reservedQuantity: { increment: line.quantity } },
      });

      await tx.stockMovement.create({
        data: {
          variantId: variant.id,
          type: StockMovementType.SALE_WEBHOOK,
          quantityChange: 0, // fiziksel stok degismedi, sadece rezerve edildi
          quantityAfter: updatedVariant.stockQuantity,
          reference: orderId,
          note: `Rezerve: ${line.quantity} adet`,
        },
      });

      return updatedVariant;
    });

    reserved.push({
      variantId: variant.id,
      stockCode: line.stockCode,
      quantity: line.quantity,
      availableAfter: fresh.stockQuantity - fresh.reservedQuantity,
    });

    // Siparis Sentos'tan geldigi icin Sentos stogu zaten dusmustur; geri gonderilmez.
  }

  return { reserved, notFound };
}

/** Terminalde urun secimi icin arama (ad, SKU, barkod). */
export async function searchVariants(q: string, limit = 20) {
  const term = q.trim();
  if (!term) return [];
  return prisma.productVariant.findMany({
    where: {
      isActive: true,
      OR: [
        { barcode: { contains: term } },
        { variantCode: { contains: term, mode: 'insensitive' } },
        { sentosStockCode: { contains: term, mode: 'insensitive' } },
        { product: { name: { contains: term, mode: 'insensitive' } } },
        { product: { mainProductCode: { contains: term, mode: 'insensitive' } } },
      ],
    },
    include: variantInclude,
    orderBy: [{ product: { name: 'asc' } }, { variantCode: 'asc' }],
    take: limit,
  });
}

export async function listMovements(params: { variantId?: number; limit?: number; operator?: string }) {
  return prisma.stockMovement.findMany({
    where: {
      ...(params.variantId ? { variantId: params.variantId } : {}),
      ...(params.operator ? { operator: params.operator } : {}),
    },
    include: { variant: { include: { product: true } } },
    orderBy: { createdAt: 'desc' },
    take: params.limit ?? 50,
  });
}

/** Terminal ekraninin gunluk ozeti. */
export async function todaySummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [scans, lowStock] = await Promise.all([
    prisma.stockMovement.count({
      where: { type: StockMovementType.WAREHOUSE_SCAN, createdAt: { gte: startOfDay } },
    }),
    prisma.productVariant.count({ where: { isActive: true, stockQuantity: { lte: 3 } } }),
  ]);

  return { scansToday: scans, lowStockVariants: lowStock };
}
