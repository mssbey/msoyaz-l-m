<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { adminApi, apiErrorMessage, formatDateTime, formatTry } from '../lib/api';

interface OrderListLine {
  id: number;
  sku: string | null;
  name: string | null;
  quantity: number;
  variantId: number | null;
  imageUrl: string | null;
}

interface OrderListItem {
  id: number;
  sentosId: number;
  orderCode: string | null;
  platformOrderId: string | null;
  status: number;
  source: string | null;
  shop: string | null;
  orderDate: string | null;
  shipDueDate: string | null;
  total: string;
  customerName: string | null;
  city: string | null;
  cargoProvider: string | null;
  cargoNumber: string | null;
  lines: OrderListLine[];
}

interface Address {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  country?: string | null;
  taxOffice?: string | null;
  taxNumber?: string | null;
}

interface OrderDetail extends OrderListItem {
  packageCode: string | null;
  orderType: string | null;
  shippingTotal: string;
  customerPhone: string | null;
  customerEmail: string | null;
  shipmentAddress: Address | null;
  invoiceAddress: Address | null;
  trackingLink: string | null;
  hasInvoice: boolean;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  note: string | null;
  firstSeenAt: string;
  lastSyncedAt: string;
  statusChangedAt: string | null;
  lines: (OrderListLine & {
    barcode: string | null;
    color: string | null;
    size: string | null;
    lineStatus: string | null;
    listPrice: string;
    price: string;
    discount: string;
    amount: string;
    vatRate: number | null;
    variant: {
      id: number;
      variantCode: string;
      barcode: string;
      stockQuantity: number;
      reservedQuantity: number;
      product: { name: string };
    } | null;
  })[];
}

interface OrderSync {
  mode: 'incremental' | 'full';
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  fetched: number;
  created: number;
  updated: number;
  statusChanged: number;
  unmatchedLines: number;
  error?: string;
}

interface Summary {
  statusLabels: Record<string, string>;
  byStatus: { status: number; count: number }[];
  bySource: { source: string | null; count: number }[];
  today: { count: number; total: string };
  unmatchedOrders: number;
  lastSync: OrderSync | null;
}

const STATUS_BADGE: Record<number, string> = { 1: 'warn', 2: 'warn', 3: 'warn', 4: 'warn', 5: 'ok', 6: 'err', 99: 'ok' };

const items = ref<OrderListItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageCount = ref(1);
const summary = ref<Summary | null>(null);
const detail = ref<OrderDetail | null>(null);
const expanded = ref<number | null>(null);

const q = ref('');
const status = ref<number | ''>('');
const source = ref('');
const unmatched = ref(false);

const loading = ref(false);
const error = ref('');
const message = ref('');
let timer: number | undefined;

const statusCount = computed(() => {
  const map: Record<number, number> = {};
  for (const row of summary.value?.byStatus ?? []) map[row.status] = row.count;
  return map;
});
const allCount = computed(() => (summary.value?.byStatus ?? []).reduce((sum, row) => sum + row.count, 0));

function statusLabel(code: number) {
  return summary.value?.statusLabels[String(code)] ?? `Durum ${code}`;
}

async function loadList() {
  loading.value = true;
  try {
    const { data } = await adminApi.get('/orders', {
      params: {
        q: q.value || undefined,
        status: status.value === '' ? undefined : status.value,
        source: source.value || undefined,
        unmatched: unmatched.value || undefined,
        page: page.value,
        pageSize: 25,
      },
    });
    items.value = data.items;
    total.value = data.total;
    pageCount.value = data.pageCount;
    error.value = '';
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

async function loadSummary() {
  try {
    const { data } = await adminApi.get<Summary>('/orders/summary');
    summary.value = data;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

const refresh = () => Promise.all([loadList(), loadSummary()]);

async function toggle(order: OrderListItem) {
  if (expanded.value === order.id) {
    expanded.value = null;
    detail.value = null;
    return;
  }
  expanded.value = order.id;
  detail.value = null;
  try {
    const { data } = await adminApi.get<OrderDetail>(`/orders/${order.id}`);
    if (expanded.value === order.id) detail.value = data;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function sync(full = false) {
  message.value = '';
  error.value = '';
  try {
    await adminApi.post('/orders/sync', { full });
    message.value = full
      ? 'Tam senkron baslatildi (son gunlerin tum siparisleri yeniden okunur).'
      : "Siparisler Sentos'tan cekiliyor...";
    window.setTimeout(refresh, 3000);
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

function formatAddress(a: Address | null) {
  if (!a) return '-';
  return [a.address, [a.district, a.city].filter(Boolean).join(' / '), a.country].filter(Boolean).join(', ');
}

function selectStatus(value: number | '') {
  status.value = value;
}

let searchTimer: number | undefined;
watch([q, status, source, unmatched], () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    page.value = 1;
    loadList();
  }, 300);
});
watch(page, loadList);

onMounted(() => {
  refresh();
  // Yeni siparisler arka planda 2 dakikada bir cekilir; ekran da 30 sn'de bir tazelenir.
  timer = window.setInterval(refresh, 30000);
});
onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <div class="card readonly-note">
    <strong>Salt okunur.</strong>
    <span class="muted">
      Siparişler Sentos'tan yalnızca okunur ve burada gösterilir. Bu ekrandan Sentos'ta hiçbir şey değiştirilmez.
    </span>
  </div>

  <div v-if="summary" class="grid cols-4" style="margin-bottom: 18px">
    <div class="stat">
      <div class="label">Bugünkü sipariş</div>
      <div class="value">{{ summary.today.count }}</div>
      <div class="muted" style="font-size: 12px">{{ formatTry(summary.today.total) }} (iptaller hariç)</div>
    </div>
    <div class="stat">
      <div class="label">Onay / hazırlık bekleyen</div>
      <div class="value">{{ (statusCount[1] ?? 0) + (statusCount[2] ?? 0) + (statusCount[3] ?? 0) + (statusCount[4] ?? 0) }}</div>
    </div>
    <div class="stat">
      <div class="label">Ürünü eşleşmeyen sipariş</div>
      <div class="value" :style="{ color: summary.unmatchedOrders ? 'var(--warn)' : undefined }">
        {{ summary.unmatchedOrders }}
      </div>
      <div class="muted" style="font-size: 12px">SKU/barkod lokal ürünlerde bulunamadi</div>
    </div>
    <div class="stat">
      <div class="label">Son senkron</div>
      <template v-if="summary.lastSync">
        <div class="value" style="font-size: 16px">
          <span v-if="summary.lastSync.running" class="badge warn">Çekiliyor...</span>
          <span v-else-if="summary.lastSync.error" class="badge err">Hata</span>
          <span v-else class="badge ok">{{ formatDateTime(summary.lastSync.finishedAt) }}</span>
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 6px">
          {{ summary.lastSync.fetched }} okundu · {{ summary.lastSync.created }} yeni ·
          {{ summary.lastSync.statusChanged }} durum değişti
        </div>
      </template>
      <div v-else class="muted">Henüz çalışmadı</div>
    </div>
  </div>

  <div v-if="summary?.lastSync?.error" class="card" style="border-color: var(--danger)">
    <strong>Son sipariş senkronu başarısız:</strong>
    <span class="muted" style="white-space: normal"> {{ summary.lastSync.error }}</span>
  </div>

  <div class="card">
    <div class="status-tabs">
      <button :class="{ active: status === '' }" @click="selectStatus('')">Tümü ({{ allCount }})</button>
      <button
        v-for="(label, code) in summary?.statusLabels ?? {}"
        :key="code"
        :class="{ active: status === Number(code) }"
        @click="selectStatus(Number(code))"
      >
        {{ label }} ({{ statusCount[Number(code)] ?? 0 }})
      </button>
    </div>

    <div class="row" style="margin-top: 12px">
      <div style="flex: 1; min-width: 220px">
        <label>Ara (sipariş no, müşteri, kargo no, SKU, barkod)</label>
        <input v-model="q" placeholder="203129724888 / Ahmet Yilmaz / 8691123469069" />
      </div>
      <div style="min-width: 160px">
        <label>Pazar yeri</label>
        <select v-model="source">
          <option value="">Tümü</option>
          <option v-for="row in summary?.bySource ?? []" :key="row.source ?? '-'" :value="row.source ?? ''">
            {{ row.source ?? '-' }} ({{ row.count }})
          </option>
        </select>
      </div>
      <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px">
        <input v-model="unmatched" type="checkbox" style="width: auto" /> Sadece eşleşmeyenler
      </label>
    </div>

    <div class="row">
      <button class="primary" :disabled="summary?.lastSync?.running" @click="sync(false)">
        {{ summary?.lastSync?.running ? 'Çekiliyor...' : "Sentos'tan Şimdi Çek" }}
      </button>
      <button :disabled="summary?.lastSync?.running" @click="sync(true)">Tam Senkron</button>
      <button :disabled="loading" @click="refresh">Yenile</button>
      <span class="muted">{{ total }} sipariş · otomatik: 2 dk'da bir</span>
      <span v-if="message" class="badge ok">{{ message }}</span>
      <span v-if="error" class="badge err">{{ error }}</span>
    </div>
  </div>

  <div class="card">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tarih</th>
            <th>Sipariş No</th>
            <th>Pazar Yeri</th>
            <th>Müşteri</th>
            <th>Ürünler</th>
            <th class="num">Tutar</th>
            <th>Durum</th>
            <th>Kargo</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="order in items" :key="order.id">
            <tr class="order-row" @click="toggle(order)">
              <td>{{ formatDateTime(order.orderDate) }}</td>
              <td>
                <strong>{{ order.orderCode ?? order.platformOrderId ?? `#${order.sentosId}` }}</strong>
                <div class="muted" style="font-size: 11px">Sentos #{{ order.sentosId }}</div>
              </td>
              <td>
                {{ order.source ?? '-' }}
                <div v-if="order.shop" class="muted" style="font-size: 11px">{{ order.shop }}</div>
              </td>
              <td>
                {{ order.customerName ?? '-' }}
                <div v-if="order.city" class="muted" style="font-size: 11px">{{ order.city }}</div>
              </td>
              <td class="lines-cell">
                <div v-for="line in order.lines.slice(0, 2)" :key="line.id">
                  <span class="qty-tag">{{ line.quantity }}x</span>
                  {{ line.name ?? line.sku ?? '-' }}
                  <span v-if="!line.variantId" class="badge warn" title="Lokal ürünlerle eşleşmedi">?</span>
                </div>
                <div v-if="order.lines.length > 2" class="muted" style="font-size: 11px">
                  +{{ order.lines.length - 2 }} kalem daha
                </div>
              </td>
              <td class="num">{{ formatTry(order.total) }}</td>
              <td><span class="badge" :class="STATUS_BADGE[order.status]">{{ statusLabel(order.status) }}</span></td>
              <td class="muted">
                {{ order.cargoProvider ?? '-' }}
                <div v-if="order.cargoNumber" style="font-size: 11px">{{ order.cargoNumber }}</div>
              </td>
              <td>
                <button @click.stop="toggle(order)">{{ expanded === order.id ? 'Kapat' : 'Detay' }}</button>
              </td>
            </tr>

            <tr v-if="expanded === order.id">
              <td colspan="9" style="background: var(--panel-2)">
                <div v-if="!detail" class="muted">Yükleniyor...</div>
                <template v-else>
                  <div class="grid cols-3" style="margin-bottom: 14px">
                    <div>
                      <h3>Müşteri</h3>
                      <div>{{ detail.customerName ?? '-' }}</div>
                      <div class="muted">{{ detail.customerPhone ?? '' }}</div>
                      <div class="muted">{{ detail.customerEmail ?? '' }}</div>
                    </div>
                    <div>
                      <h3>Teslimat Adresi</h3>
                      <div>{{ detail.shipmentAddress?.name ?? '' }}</div>
                      <div class="muted" style="white-space: normal">{{ formatAddress(detail.shipmentAddress) }}</div>
                    </div>
                    <div>
                      <h3>Fatura</h3>
                      <div class="muted" style="white-space: normal">{{ formatAddress(detail.invoiceAddress) }}</div>
                      <div v-if="detail.invoiceAddress?.taxNumber" class="muted">
                        VD: {{ detail.invoiceAddress.taxOffice }} / {{ detail.invoiceAddress.taxNumber }}
                      </div>
                      <div v-if="detail.hasInvoice" style="margin-top: 4px">
                        <a v-if="detail.invoiceUrl" :href="detail.invoiceUrl" target="_blank" rel="noopener">
                          {{ detail.invoiceNumber ?? 'Faturayi aç' }}
                        </a>
                        <span v-else>{{ detail.invoiceNumber }}</span>
                      </div>
                      <div v-else class="muted">Fatura kesilmedi</div>
                    </div>
                  </div>

                  <div class="grid cols-4" style="margin-bottom: 14px">
                    <div><span class="muted">Pazar yeri sipariş no:</span> {{ detail.platformOrderId ?? '-' }}</div>
                    <div><span class="muted">Paket:</span> {{ detail.packageCode ?? '-' }}</div>
                    <div><span class="muted">Son kargo tarihi:</span> {{ formatDateTime(detail.shipDueDate) }}</div>
                    <div><span class="muted">Ödeme:</span> {{ detail.paymentMethod ?? '-' }} {{ detail.paymentStatus ?? '' }}</div>
                    <div>
                      <span class="muted">Kargo takip:</span>
                      <a v-if="detail.trackingLink" :href="detail.trackingLink" target="_blank" rel="noopener">
                        {{ detail.cargoNumber ?? 'Takip' }}
                      </a>
                      <span v-else>{{ detail.cargoNumber ?? '-' }}</span>
                    </div>
                    <div><span class="muted">Kargo ücreti:</span> {{ formatTry(detail.shippingTotal) }}</div>
                    <div><span class="muted">Durum değişimi:</span> {{ formatDateTime(detail.statusChangedAt) }}</div>
                    <div><span class="muted">Son okuma:</span> {{ formatDateTime(detail.lastSyncedAt) }}</div>
                  </div>
                  <p v-if="detail.note" style="margin-top: 0"><span class="muted">Not:</span> {{ detail.note }}</p>

                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Ürün</th>
                        <th>SKU / Barkod</th>
                        <th>Renk / Beden</th>
                        <th class="num">Adet</th>
                        <th class="num">Birim</th>
                        <th class="num">Tutar</th>
                        <th>Lokal Ürün</th>
                        <th class="num">Lokal Stok</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="line in detail.lines" :key="line.id">
                        <td><img v-if="line.imageUrl" :src="line.imageUrl" class="thumb" alt="" /></td>
                        <td style="white-space: normal">{{ line.name ?? '-' }}</td>
                        <td>
                          {{ line.sku ?? '-' }}
                          <div class="muted" style="font-size: 11px">{{ line.barcode ?? '' }}</div>
                        </td>
                        <td class="muted">{{ [line.color, line.size].filter(Boolean).join(' / ') || '-' }}</td>
                        <td class="num">{{ line.quantity }}</td>
                        <td class="num">{{ formatTry(line.price) }}</td>
                        <td class="num">{{ formatTry(line.amount) }}</td>
                        <td>
                          <template v-if="line.variant">
                            <strong>{{ line.variant.variantCode }}</strong>
                            <div class="muted" style="font-size: 11px">{{ line.variant.product.name }}</div>
                          </template>
                          <span v-else class="badge warn">Eşleşmedi</span>
                        </td>
                        <td class="num">{{ line.variant ? line.variant.stockQuantity : '-' }}</td>
                      </tr>
                    </tbody>
                  </table>
                </template>
              </td>
            </tr>
          </template>
          <tr v-if="!items.length">
            <td colspan="9" class="muted">
              {{ loading ? 'Yükleniyor...' : "Sipariş yok. Sentos API bilgileri girildiyse \"Sentos'tan Şimdi Çek\" ile başlatın." }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="pageCount > 1" class="row" style="margin-top: 12px; justify-content: flex-end">
      <button :disabled="page <= 1" @click="page -= 1">Önceki</button>
      <span class="muted">{{ page }} / {{ pageCount }}</span>
      <button :disabled="page >= pageCount" @click="page += 1">Sonraki</button>
    </div>
  </div>
</template>

<style scoped>
.readonly-note {
  border-color: var(--accent);
}
.status-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.status-tabs button.active {
  border-color: var(--accent);
  color: var(--accent);
}
.order-row {
  cursor: pointer;
}
.lines-cell {
  white-space: normal;
  max-width: 320px;
  font-size: 13px;
}
.qty-tag {
  color: var(--muted);
  margin-right: 4px;
}
h3 {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
}
.thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 6px;
}
</style>
