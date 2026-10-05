import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../http/middleware/error.js';
import { prisma } from '../../lib/prisma.js';
import { enqueueOrderSync } from '../../queues/producers.js';
import { getLastOrderSync } from './orders-sync.service.js';
import { ORDER_STATUS_LABELS } from './orders.mapper.js';

/**
 * Sentos siparislerinin lokal kopyasi. Buradaki uclar yalnizca okur;
 * "senkron" ucu da sadece Sentos'tan cekme isini kuyruga atar.
 */
export const ordersRouter = Router();

const listQuery = z.object({
  q: z.string().trim().optional(),
  status: z.coerce.number().int().optional(),
  source: z.string().trim().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  unmatched: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

function buildWhere(query: z.infer<typeof listQuery>): Prisma.SentosOrderWhereInput {
  const where: Prisma.SentosOrderWhereInput = {};
  if (query.status !== undefined) where.status = query.status;
  if (query.source) where.source = query.source;
  if (query.from || query.to) {
    where.orderDate = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lte: new Date(query.to) } : {}),
    };
  }
  if (query.unmatched === 'true') where.lines = { some: { variantId: null } };
  if (query.q) {
    const q = query.q;
    where.OR = [
      { orderCode: { contains: q, mode: 'insensitive' } },
      { platformOrderId: { contains: q, mode: 'insensitive' } },
      { packageCode: { contains: q, mode: 'insensitive' } },
      { customerName: { contains: q, mode: 'insensitive' } },
      { cargoNumber: { contains: q, mode: 'insensitive' } },
      { lines: { some: { OR: [{ sku: { contains: q, mode: 'insensitive' } }, { barcode: { contains: q } }, { name: { contains: q, mode: 'insensitive' } }] } } },
    ];
  }
  return where;
}

ordersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = listQuery.parse(req.query);
    const where = buildWhere(query);

    const [total, items] = await Promise.all([
      prisma.sentosOrder.count({ where }),
      prisma.sentosOrder.findMany({
        where,
        orderBy: [{ orderDate: 'desc' }, { sentosId: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        omit: { raw: true, shipmentAddress: true, invoiceAddress: true },
        include: {
          lines: {
            select: { id: true, sku: true, name: true, quantity: true, variantId: true, imageUrl: true },
          },
        },
      }),
    ]);

    res.json({ items, total, page: query.page, pageCount: Math.max(1, Math.ceil(total / query.pageSize)) });
  }),
);

/** Durum ve pazar yeri kirilimi, bugunun ozeti ve son senkron bilgisi. */
ordersRouter.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [byStatus, bySource, today, unmatchedOrders, lastSync] = await Promise.all([
      prisma.sentosOrder.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.sentosOrder.groupBy({ by: ['source'], _count: { _all: true }, orderBy: { source: 'asc' } }),
      prisma.sentosOrder.aggregate({
        where: { orderDate: { gte: startOfDay }, status: { not: 6 } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      prisma.sentosOrder.count({ where: { lines: { some: { variantId: null } } } }),
      getLastOrderSync(),
    ]);

    res.json({
      statusLabels: ORDER_STATUS_LABELS,
      byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
      bySource: bySource.map((row) => ({ source: row.source, count: row._count._all })),
      today: { count: today._count._all, total: today._sum.total ?? '0' },
      unmatchedOrders,
      lastSync,
    });
  }),
);

/** Sentos'tan siparisleri simdi cek. `full: true` imleci yok sayip son N gunu yeniden okur. */
ordersRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    const { full } = z.object({ full: z.boolean().optional() }).parse(req.body ?? {});
    const job = await enqueueOrderSync(full ? 'manual_full' : 'manual', full ?? false);
    res.status(202).json({ queued: true, jobId: job.id });
  }),
);

ordersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = z.coerce.number().int().parse(req.params.id);
    const order = await prisma.sentosOrder.findUnique({
      where: { id },
      include: {
        lines: {
          orderBy: { id: 'asc' },
          include: {
            variant: {
              select: {
                id: true,
                variantCode: true,
                barcode: true,
                stockQuantity: true,
                reservedQuantity: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!order) return res.status(404).json({ error: 'Siparis bulunamadi.' });
    return res.json(order);
  }),
);
