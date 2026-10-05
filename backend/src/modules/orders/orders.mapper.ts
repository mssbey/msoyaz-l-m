import type { SentosOrder, SentosOrderLine } from '../sentos/sentos.client.js';

/** Sentos siparis durum kodlari (API v1.5). */
export const ORDER_STATUS_LABELS: Record<number, string> = {
  1: 'Onay Bekliyor',
  2: 'Onaylandi',
  3: 'Tedarik Surecinde',
  4: 'Hazirlaniyor',
  5: 'Kargoya Verildi',
  6: 'Iptal Edildi',
  99: 'Teslim Edildi',
};

/** Sentos tarihleri saat dilimi belirtmeden Turkiye saatiyle gelir ("2026-01-28 13:48:00"). */
export function parseSentosDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(text);
  const [, day, time] = match ?? [];
  const date = day && time ? new Date(`${day}T${time.length === 5 ? `${time}:00` : time}+03:00`) : new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Sentos sorgu parametresi bicimi: Turkiye saatiyle "YYYY-MM-DD HH:mm:ss". */
export function formatSentosDate(date: Date): string {
  const shifted = new Date(date.getTime() + 3 * 3600 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

/** "29,90" / "29.90" / 29.9 -> "29.90"; gecersizse "0". Decimal alanlara string verilir. */
export function toMoney(value: unknown): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n.toFixed(2) : '0';
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function firstImage(images: unknown): string | null {
  if (!images) return null;
  const list = Array.isArray(images) ? images : [images];
  const first = list[0] as { url?: string } | string | undefined;
  if (!first) return null;
  return typeof first === 'string' ? first : str(first.url);
}

export interface NormalizedOrderLineRow {
  sentosLineId: string | null;
  sku: string | null;
  barcode: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  lineStatus: string | null;
  quantity: number;
  listPrice: string;
  price: string;
  discount: string;
  amount: string;
  vatRate: number | null;
  imageUrl: string | null;
}

export function normalizeOrderLine(line: SentosOrderLine): NormalizedOrderLineRow {
  const quantity = Math.trunc(Number(line.quantity ?? 1));
  const vat = Number(line.vat_rate);
  return {
    sentosLineId: str(line.orderlineid ?? line.id),
    sku: str(line.sku),
    barcode: str(line.barcode),
    name: str(line.name),
    color: str(line.color),
    size: str(line.model?.value),
    lineStatus: str(line.status),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    listPrice: toMoney(line.list_price),
    price: toMoney(line.price),
    discount: toMoney(line.discount),
    amount: toMoney(line.amount ?? line.price),
    vatRate: Number.isFinite(vat) ? Math.trunc(vat) : null,
    imageUrl: firstImage(line.images),
  };
}

/** Sentos siparisini lokal `sentos_orders` satirina cevirir (satirlar haric). */
export function normalizeOrder(order: SentosOrder) {
  const status = Math.trunc(Number(order.status));
  const shipment = order.shipment_address ?? null;
  return {
    sentosId: Number(order.id),
    platformOrderId: str(order.order_id),
    orderCode: str(order.order_code),
    packageCode: str(order.package_code),
    status: Number.isFinite(status) ? status : 0,
    source: str(order.source),
    shop: str(order.shop),
    orderType: str(order.order_type),
    orderDate: parseSentosDate(order.order_date),
    shipDueDate: parseSentosDate(order.ship_due_date),
    total: toMoney(order.total),
    shippingTotal: toMoney(order.shipping_total),
    customerName: str(order.customer?.name) ?? str(shipment?.name),
    customerPhone: str(order.customer?.phone) ?? str(shipment?.phone),
    customerEmail: str(order.customer?.mail_address),
    city: str(shipment?.city),
    district: str(shipment?.district),
    shipmentAddress: shipment,
    invoiceAddress: order.invoice_address ?? null,
    cargoProvider: str(order.tracking_info?.cargo_company) ?? str(order.cargo_provider),
    cargoNumber: str(order.tracking_info?.tracking_number) ?? str(order.cargo_number),
    trackingLink: str(order.tracking_info?.tracking_link),
    hasInvoice: String(order.has_invoice ?? '').toLowerCase() === 'yes',
    invoiceNumber: str(order.invoice_number),
    invoiceUrl: str(order.invoice_url),
    paymentMethod: str(order.payment_method),
    paymentStatus: str(order.payment_status),
    note: str(order.note),
    sentosCreatedAt: parseSentosDate(order.created_at),
    lines: (Array.isArray(order.lines) ? order.lines : []).map(normalizeOrderLine),
  };
}

export type NormalizedOrder = ReturnType<typeof normalizeOrder>;
