<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { adminApi, apiErrorMessage, formatDateTime } from '../lib/api';

interface SyncLog {
  id: number;
  jobType: string;
  status: string;
  httpStatus: number | null;
  durationMs: number | null;
  attempt: number;
  error: string | null;
  createdAt: string;
}

interface WebhookEvent {
  id: number;
  eventType: string;
  externalId: string;
  status: string;
  error: string | null;
  processedAt: string | null;
  createdAt: string;
}

interface SentosStatus {
  configured: boolean;
  dryRun: boolean;
  readOnly: boolean;
  baseUrl: string;
  requestsPerMinute: number;
  warehouseId: number | null;
  pendingVariants: number;
  failed: { id: number; variantCode: string; name: string; pendingSentosDelta: number; error: string | null }[];
  linkedVariants: number;
  totalVariants: number;
  lastSync: {
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
  } | null;
}

const status = ref<SentosStatus | null>(null);
const warehouses = ref<{ id: number; name: string }[]>([]);
const selectedWarehouse = ref<number | null>(null);
const warehouseLoaded = ref(false);
const logs = ref<SyncLog[]>([]);
const webhooks = ref<WebhookEvent[]>([]);
const error = ref('');
const message = ref('');
let timer: number | undefined;

const BADGE: Record<string, string> = {
  SUCCESS: 'ok',
  PROCESSED: 'ok',
  PENDING: 'warn',
  QUEUED: 'warn',
  RECEIVED: 'warn',
  SKIPPED: '',
  DUPLICATE: '',
  FAILED: 'err',
};

async function load() {
  try {
    const [logsResponse, webhookResponse, statusResponse] = await Promise.all([
      adminApi.get('/sentos/logs', { params: { limit: 50 } }),
      adminApi.get('/sentos/webhooks', { params: { limit: 25 } }),
      adminApi.get<SentosStatus>('/sentos/status'),
    ]);
    logs.value = logsResponse.data.items;
    webhooks.value = webhookResponse.data.items;
    status.value = statusResponse.data;
    if (!warehouseLoaded.value) {
      selectedWarehouse.value = statusResponse.data.warehouseId;
      warehouseLoaded.value = true;
    }
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function action(fn: () => Promise<string>) {
  message.value = '';
  error.value = '';
  try {
    message.value = await fn();
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

const syncProducts = () =>
  action(async () => {
    await adminApi.post('/sentos/sync-products');
    return 'Urun senkronu baslatildi. Ilerleme asagida gorunur.';
  });

const retryStock = () =>
  action(async () => {
    const { data } = await adminApi.post('/sentos/retry-stock');
    return `${data.queuedProducts} urunun stok aktarimi tekrar kuyruga alindi.`;
  });

const loadWarehouses = (refresh = false) =>
  action(async () => {
    const { data } = await adminApi.get('/sentos/warehouses', { params: { refresh } });
    warehouses.value = data.items;
    return refresh ? `${data.items.length} depo bulundu.` : '';
  });

const saveWarehouse = () =>
  action(async () => {
    await adminApi.put('/sentos/warehouse', { warehouseId: selectedWarehouse.value });
    return 'Varsayilan cikis deposu kaydedildi.';
  });

onMounted(() => {
  load();
  void loadWarehouses();
  timer = window.setInterval(load, 10000);
});

onUnmounted(() => window.clearInterval(timer));
</script>

<template>
  <div class="card">
    <div class="row">
      <button class="primary" :disabled="status?.lastSync?.running" @click="syncProducts">
        {{ status?.lastSync?.running ? 'Ürünler çekiliyor...' : "Ürünleri Sentos'tan Çek" }}
      </button>
      <button @click="retryStock">Hatalı Stok Aktarimlarini Tekrar Dene</button>
      <button @click="load">Yenile</button>
      <span class="muted">Sayfa 10 saniyede bir yenilenir.</span>
      <span v-if="message" class="badge ok">{{ message }}</span>
      <span v-if="error" class="badge err">{{ error }}</span>
    </div>
  </div>

  <div v-if="status" class="grid cols-4" style="margin-bottom: 18px">
    <div class="stat">
      <div class="label">Baglanti</div>
      <div class="value" style="font-size: 16px">
        <span v-if="!status.configured" class="badge err">API bilgisi yok</span>
        <span v-else class="badge ok">Salt okunur</span>
      </div>
      <div class="muted" style="font-size: 12px; margin-top: 6px">{{ status.baseUrl }}</div>
    </div>
    <div class="stat">
      <div class="label">Sentos ile eslesen varyant</div>
      <div class="value">{{ status.linkedVariants }} / {{ status.totalVariants }}</div>
    </div>
    <div class="stat">
      <div class="label">Sentos'a iletilmeyi bekleyen</div>
      <div class="value">{{ status.pendingVariants }}</div>
      <div class="muted" style="font-size: 12px">Limit: {{ status.requestsPerMinute }} istek/dk</div>
    </div>
    <div class="stat">
      <div class="label">Hatalı aktarım</div>
      <div class="value" :style="{ color: status.failed.length ? 'var(--danger)' : undefined }">
        {{ status.failed.length }}
      </div>
    </div>
  </div>

  <div v-if="status?.readOnly" class="card" style="border-color: var(--accent)">
    <strong>Salt okunur entegrasyon.</strong>
    <span class="muted">
      Ürünler, stoklar ve siparişler Sentos'tan yalnızca okunur. Bu yazilim Sentos'a hiçbir istek yazmaz;
      okutmalar yalnızca lokal stoğu etkiler ve bir sonraki ürün senkronunda Sentos'taki degere doner.
    </span>
  </div>

  <div class="grid cols-2">
    <div class="card">
      <h2>Son Ürün Senkronu</h2>
      <template v-if="status?.lastSync">
        <table>
          <tbody>
            <tr><td class="muted">Baslangic</td><td>{{ formatDateTime(status.lastSync.startedAt) }}</td></tr>
            <tr>
              <td class="muted">Bitis</td>
              <td>{{ status.lastSync.running ? 'Devam ediyor...' : formatDateTime(status.lastSync.finishedAt) }}</td>
            </tr>
            <tr><td class="muted">Ürün / sayfa</td><td>{{ status.lastSync.products }} / {{ status.lastSync.pages }}</td></tr>
            <tr><td class="muted">Yeni varyant</td><td>{{ status.lastSync.variantsCreated }}</td></tr>
            <tr><td class="muted">Guncellenen varyant</td><td>{{ status.lastSync.variantsUpdated }}</td></tr>
            <tr><td class="muted">Stoğu değişen</td><td>{{ status.lastSync.stockChanged }}</td></tr>
          </tbody>
        </table>
        <p v-if="status.lastSync.error" class="badge err" style="white-space: normal">{{ status.lastSync.error }}</p>
        <details v-if="status.lastSync.skipped.length" style="margin-top: 10px">
          <summary class="muted">Atlanan kayitlar ({{ status.lastSync.skipped.length }})</summary>
          <div class="table-wrap">
            <table>
              <tbody>
                <tr v-for="row in status.lastSync.skipped" :key="row.sku + row.reason">
                  <td>{{ row.sku }}</td>
                  <td class="muted" style="white-space: normal">{{ row.reason }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </template>
      <p v-else class="muted">Henüz senkron yapilmadi. "Ürünleri Sentos'tan Çek" ile başlatın.</p>
    </div>

    <div class="card">
      <h2>Çıkış Deposu</h2>
      <p class="muted" style="margin-top: 0">
        Barkod okutuldugunda stok önce bu depodan dusulur; yetmezse en cok stoğu olan diğer depodan tamamlanir.
      </p>
      <div class="row">
        <div style="flex: 1; min-width: 180px">
          <label>Depo</label>
          <select v-model="selectedWarehouse">
            <option :value="null">Otomatik (urunun ilk deposu)</option>
            <option v-for="w in warehouses" :key="w.id" :value="w.id">{{ w.name }} (#{{ w.id }})</option>
          </select>
        </div>
        <button @click="saveWarehouse">Kaydet</button>
        <button @click="loadWarehouses(true)">Depolari Yenile</button>
      </div>
    </div>
  </div>

  <div v-if="status?.failed.length" class="card" style="border-color: var(--danger)">
    <h2>Sentos'a İletilemeyen Stok Dususleri</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Varyant</th><th>Ürün</th><th class="num">Bekleyen</th><th>Hata</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in status.failed" :key="row.id">
            <td>{{ row.variantCode }}</td>
            <td>{{ row.name }}</td>
            <td class="num">{{ row.pendingSentosDelta }}</td>
            <td class="muted" style="white-space: normal">{{ row.error }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Sentos API Istekleri</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tarih</th>
            <th>Tip</th>
            <th>Durum</th>
            <th class="num">HTTP</th>
            <th class="num">Süre (ms)</th>
            <th class="num">Deneme</th>
            <th>Hata</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in logs" :key="log.id">
            <td>{{ formatDateTime(log.createdAt) }}</td>
            <td>{{ log.jobType }}</td>
            <td><span class="badge" :class="BADGE[log.status]">{{ log.status }}</span></td>
            <td class="num">{{ log.httpStatus ?? '-' }}</td>
            <td class="num">{{ log.durationMs ?? '-' }}</td>
            <td class="num">{{ log.attempt }}</td>
            <td class="muted">{{ log.error ?? '-' }}</td>
          </tr>
          <tr v-if="!logs.length"><td colspan="7" class="muted">Kayıt yok.</td></tr>
        </tbody>
      </table>
    </div>
    <p class="muted" style="margin-bottom: 0">
      SKIPPED durumu, salt okunur kural geregi engellenen (Sentos'a gonderilmeyen) yazma isteklerini gosterir.
    </p>
  </div>

  <div class="card">
    <h2>Gelen Sipariş Webhook'lari</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Tarih</th>
            <th>Olay</th>
            <th>Sipariş No</th>
            <th>Durum</th>
            <th>Islenme</th>
            <th>Not</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="event in webhooks" :key="event.id">
            <td>{{ formatDateTime(event.createdAt) }}</td>
            <td>{{ event.eventType }}</td>
            <td>{{ event.externalId }}</td>
            <td><span class="badge" :class="BADGE[event.status]">{{ event.status }}</span></td>
            <td>{{ formatDateTime(event.processedAt) }}</td>
            <td class="muted">{{ event.error ?? '-' }}</td>
          </tr>
          <tr v-if="!webhooks.length"><td colspan="6" class="muted">Kayıt yok.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
code {
  background: var(--panel-2);
  padding: 1px 5px;
  border-radius: 5px;
}
</style>
