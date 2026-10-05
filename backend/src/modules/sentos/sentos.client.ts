import axios, { AxiosError, type AxiosInstance, type Method } from 'axios';
import { SyncStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Sentos API kopru katmani (https://api.sentos.com.tr/docs, v1.5).
 *
 * - Kimlik dogrulama: Basic Auth (kullanici = "API Anahtar", sifre = "API Sifre").
 * - Base URL: panelde gorunen "API Url" (https://<firma>.sentos.com.tr/api).
 * - Limit: POST 12/dk, ayni GET 2/dk. Kuyruk worker'lari bu sinirin altinda calisir.
 *
 * SALT OKUNUR: Bu yazilim Sentos'a hicbir kosulda yazmaz. GET disindaki her istek
 * `call` icinde engellenir ve yalnizca SKIPPED olarak loglanir. Bu kural bir ortam
 * degiskenine bagli degildir; kasitli olarak koddan sabittir.
 */
export const SENTOS_READ_ONLY = true as const;

export const SENTOS_ENDPOINTS = {
  products: '/products',
  product: (id: number) => `/products/${id}`,
  warehouses: '/warehouses',
  orders: '/orders',
  order: (id: number) => `/orders/${id}`,
  /** Fiyat aktarimi henuz gercek uca bagli degil (SENTOS_PRICE_PUSH_ENABLED). */
  priceUpdate: '/products/price',
} as const;

/** Sentos stok satiri. `warehouse` dokumanda sayi, bazi yanitlarda nesne olarak gelir. */
export interface SentosStockEntry {
  warehouse: number | string | { id: number | string; name?: string };
  stock: number | string;
}

export interface SentosVariant {
  id?: number;
  sku: string;
  barcode?: string | null;
  color?: string | null;
  model?: { name?: string; value?: string } | null;
  stocks?: SentosStockEntry[];
  images?: unknown;
  [key: string]: unknown;
}

export interface SentosProduct {
  id: number;
  sku: string;
  name: string;
  brand?: string | null;
  barcode?: string | null;
  category_id?: number | null;
  stocks?: SentosStockEntry[];
  images?: { id?: number; url: string }[];
  variants?: SentosVariant[];
  [key: string]: unknown;
}

export interface SentosWarehouse {
  id: number;
  name: string;
}

export interface SentosOrderAddress {
  id?: number;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  country?: string | null;
  zipCode?: string | null;
  [key: string]: unknown;
}

export interface SentosOrderLine {
  id?: number;
  orderlineid?: number | string | null;
  sku?: string | null;
  barcode?: string | null;
  status?: string | null;
  name?: string | null;
  quantity?: number | string | null;
  list_price?: number | string | null;
  price?: number | string | null;
  discount?: number | string | null;
  amount?: number | string | null;
  currency?: string | null;
  vat_rate?: number | string | null;
  color?: string | null;
  model?: { name?: string | null; value?: string | null } | null;
  images?: unknown;
  [key: string]: unknown;
}

/** GET /orders satiri (Sentos API v1.5). */
export interface SentosOrder {
  id: number;
  order_id?: string | number | null;
  order_code?: string | number | null;
  package_code?: string | null;
  status?: number | string | null;
  source?: string | null;
  shop?: string | null;
  order_type?: string | null;
  order_date?: string | null;
  total?: number | string | null;
  shipping_total?: number | string | null;
  cargo_provider?: string | null;
  cargo_number?: string | number | null;
  cargo_label?: string | null;
  ship_due_date?: string | null;
  has_invoice?: string | null;
  invoice_number?: string | null;
  invoice_url?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  note?: string | null;
  created_at?: string | null;
  customer?: { id?: number; name?: string | null; phone?: string | null; mail_address?: string | null } | null;
  tracking_info?: { cargo_company?: string | null; tracking_number?: string | null; tracking_link?: string | null } | null;
  invoice_address?: SentosOrderAddress | null;
  shipment_address?: SentosOrderAddress | null;
  lines?: SentosOrderLine[];
  [key: string]: unknown;
}

export interface SentosOrderQuery {
  page: number;
  size: number;
  start_date?: string;
  end_date?: string;
  created_start_date?: string;
  created_end_date?: string;
  updated_start_date?: string;
  updated_end_date?: string;
  orderby_field?: 'id' | 'created_at' | 'updated_at' | 'ship_due_date';
  orderby_direction?: 'ASC' | 'DESC';
}

export interface SentosPriceItem {
  stockCode: string;
  marketplace: string;
  salePrice: number;
  listPrice?: number;
  currency: 'TRY';
}

export interface SentosCallResult<T = unknown> {
  ok: boolean;
  httpStatus?: number;
  data?: T;
  error?: string;
  durationMs: number;
  dryRun: boolean;
}

interface CallContext {
  jobType: string;
  /** Log kaydindaki varlik tipi (varsayilan PRODUCT) */
  entityType?: string;
  entityId?: number;
  attempt?: number;
  /** Yanit govdesi loga yazilsin mi (liste yanitlari buyuk oldugu icin varsayilan hayir) */
  logResponse?: boolean;
}

class SentosClient {
  private http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: env.SENTOS_BASE_URL,
      timeout: env.SENTOS_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { username: env.SENTOS_API_KEY, password: env.SENTOS_API_SECRET },
    });
  }

  get isConfigured() {
    return Boolean(env.SENTOS_API_KEY && env.SENTOS_API_SECRET);
  }

  private async call<T>(
    method: Method,
    endpoint: string,
    options: { params?: Record<string, unknown>; data?: unknown },
    context: CallContext,
  ): Promise<SentosCallResult<T>> {
    const startedAt = Date.now();
    const isWrite = method.toUpperCase() !== 'GET';
    const requestLog = { method: method.toUpperCase(), endpoint, params: options.params, body: options.data };

    if (!this.isConfigured) {
      const error = 'SENTOS_API_KEY / SENTOS_API_SECRET tanimli degil.';
      await this.log({ ...context, request: requestLog, status: SyncStatus.FAILED, durationMs: 0, error });
      return { ok: false, error, durationMs: 0, dryRun: false };
    }

    // Sentos'a yazma yok: GET disindaki hicbir istek ag katmanina ulasmaz.
    if (isWrite && SENTOS_READ_ONLY) {
      logger.warn(requestLog, 'Salt okunur mod - Sentos yazma istegi engellendi');
      await this.log({
        ...context,
        request: requestLog,
        status: SyncStatus.SKIPPED,
        durationMs: 0,
        httpStatus: 0,
        error: 'Salt okunur: Sentos yazma istegi engellendi',
      });
      return { ok: true, dryRun: true, durationMs: 0 };
    }

    try {
      const response = await this.http.request<T>({ method, url: endpoint, params: options.params, data: options.data });
      const durationMs = Date.now() - startedAt;
      await this.log({
        ...context,
        request: requestLog,
        status: SyncStatus.SUCCESS,
        httpStatus: response.status,
        durationMs,
        responseBody: context.logResponse ? response.data : undefined,
      });
      return { ok: true, httpStatus: response.status, data: response.data, durationMs, dryRun: false };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const axiosError = err as AxiosError;
      const httpStatus = axiosError.response?.status;
      const responseData = axiosError.response?.data;
      const message = responseData ? JSON.stringify(responseData).slice(0, 2000) : axiosError.message;

      await this.log({ ...context, request: requestLog, status: SyncStatus.FAILED, httpStatus, durationMs, error: message });
      return { ok: false, httpStatus, error: message, durationMs, dryRun: false };
    }
  }

  private async log(input: CallContext & {
    request: unknown;
    status: SyncStatus;
    httpStatus?: number;
    durationMs: number;
    error?: string;
    responseBody?: unknown;
  }) {
    try {
      await prisma.sentosSyncLog.create({
        data: {
          jobType: input.jobType,
          entityType: input.entityType ?? 'PRODUCT',
          entityId: input.entityId ?? null,
          payload: input.request as object,
          status: input.status,
          httpStatus: input.httpStatus ?? null,
          responseBody: input.responseBody === undefined ? null : JSON.stringify(input.responseBody).slice(0, 4000),
          durationMs: input.durationMs,
          attempt: input.attempt ?? 1,
          error: input.error ?? null,
        },
      });
    } catch (err) {
      logger.error({ err }, 'Sentos log kaydi yazilamadi');
    }
  }

  /** 429 / 5xx / ag hatalarinda BullMQ'nun tekrar denemesi icin hata firlatilir. */
  static isRetryable(result: SentosCallResult): boolean {
    if (result.ok) return false;
    if (!result.httpStatus) return true;
    return result.httpStatus === 429 || result.httpStatus >= 500;
  }

  /** Urun listesi (sayfali). Yanit bicimi dizi ya da { data: [...] } olabilir. */
  async listProducts(page: number, size: number) {
    const result = await this.call<unknown>(
      'GET',
      SENTOS_ENDPOINTS.products,
      { params: { page, size, orderby_id: 'ASC' } },
      { jobType: 'PRODUCT_PULL' },
    );
    return { ...result, data: result.ok ? extractList<SentosProduct>(result.data) : undefined };
  }

  async getProduct(id: number, attempt = 1) {
    const result = await this.call<unknown>(
      'GET',
      SENTOS_ENDPOINTS.product(id),
      {},
      { jobType: 'PRODUCT_GET', entityId: id, attempt },
    );
    return { ...result, data: result.ok ? extractOne<SentosProduct>(result.data) : undefined };
  }

  /** Urun guncelleme. Stok icin govde: { stocks } veya { variants: [{ sku, stocks }] }. */
  async updateProduct(id: number, body: Record<string, unknown>, attempt = 1) {
    return this.call<unknown>('PUT', SENTOS_ENDPOINTS.product(id), { data: body }, {
      jobType: 'STOCK_PUSH',
      entityId: id,
      attempt,
      logResponse: true,
    });
  }

  async listWarehouses() {
    const result = await this.call<unknown>('GET', SENTOS_ENDPOINTS.warehouses, {}, { jobType: 'WAREHOUSE_PULL' });
    return { ...result, data: result.ok ? extractList<SentosWarehouse>(result.data) : undefined };
  }

  /**
   * Siparis listesi. Sentos dokumani parametrelerin govdede gonderilmesini istiyor;
   * GET govdesini atan ara katmanlara karsi ayni degerler query'de de gonderilir.
   */
  async listOrders(query: SentosOrderQuery) {
    const params = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined));
    const result = await this.call<unknown>(
      'GET',
      SENTOS_ENDPOINTS.orders,
      { params, data: params },
      { jobType: 'ORDER_PULL', entityType: 'ORDER' },
    );
    return { ...result, data: result.ok ? extractList<SentosOrder>(result.data) : undefined };
  }

  async getOrder(id: number) {
    const result = await this.call<unknown>(
      'GET',
      SENTOS_ENDPOINTS.order(id),
      {},
      { jobType: 'ORDER_GET', entityType: 'ORDER', entityId: id },
    );
    return { ...result, data: result.ok ? extractOne<SentosOrder>(result.data) : undefined };
  }

  async pushPrices(items: SentosPriceItem[], attempt = 1): Promise<SentosCallResult> {
    if (!env.SENTOS_PRICE_PUSH_ENABLED) {
      await this.log({
        jobType: 'PRICE_PUSH',
        attempt,
        request: { endpoint: SENTOS_ENDPOINTS.priceUpdate, count: items.length },
        status: SyncStatus.SKIPPED,
        durationMs: 0,
        error: 'SENTOS_PRICE_PUSH_ENABLED=false',
      });
      return { ok: true, dryRun: true, durationMs: 0 };
    }
    return this.call('POST', SENTOS_ENDPOINTS.priceUpdate, { data: { items } }, { jobType: 'PRICE_PUSH', attempt });
  }
}

function extractList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    for (const key of ['data', 'products', 'orders', 'items', 'result']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

function extractOne<T>(body: unknown): T | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (Array.isArray(body)) return body[0] as T | undefined;
  const obj = body as Record<string, unknown>;
  if ('id' in obj) return obj as T;
  for (const key of ['data', 'product', 'order']) {
    const inner = obj[key];
    if (Array.isArray(inner)) return inner[0] as T | undefined;
    if (inner && typeof inner === 'object') return inner as T;
  }
  return undefined;
}

export const sentosClient = new SentosClient();
export { SentosClient };
