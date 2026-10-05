<script setup lang="ts">
import { onMounted, ref } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { operations } from '../lib/navigation';
import { adminApi, apiErrorMessage, formatDateTime, formatNumber } from '../lib/api';

interface DashboardData {
  settings: Record<string, string>;
  counts: Record<string, number>;
  lastMovements: {
    id: number;
    type: string;
    quantityChange: number;
    quantityAfter: number;
    createdAt: string;
    operator: string | null;
    reference: string | null;
    variant: { variantCode: string; product: { name: string } };
  }[];
}

interface StatusData {
  prices: Record<string, number>;
  queues: { queue: string; counts: Record<string, number> }[];
}

const data = ref<DashboardData | null>(null);
const status = ref<StatusData | null>(null);
const error = ref('');
const busy = ref(false);
const message = ref('');

const MOVEMENT_LABELS: Record<string, string> = {
  WAREHOUSE_SCAN: 'Depo Cikis',
  SALE_WEBHOOK: 'Siparis Rezerv',
  MANUAL_ADJUST: 'Elle Duzeltme',
  SYNC_CORRECTION: 'Mutabakat',
  RETURN: 'Iade',
  PURCHASE_IN: 'Mal Kabul',
};

async function load() {
  error.value = '';
  try {
    const [dashboard, priceStatus] = await Promise.all([
      adminApi.get<DashboardData>('/dashboard'),
      adminApi.get<StatusData>('/pricing/status'),
    ]);
    data.value = dashboard.data;
    status.value = priceStatus.data;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function run(action: 'recalculate' | 'push') {
  busy.value = true;
  message.value = '';
  try {
    const url = action === 'recalculate' ? '/pricing/recalculate' : '/pricing/push';
    const response = await adminApi.post(url, {});
    message.value =
      action === 'recalculate'
        ? 'Toplu fiyat hesaplama kuyruga alindi.'
        : `Kuyruga alindi: ${response.data.prices ?? 0} fiyat, ${response.data.chunks ?? 0} parca.`;
    setTimeout(load, 2500);
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="dashboard-welcome"><div><div class="eyebrow">DAHA DÜZENLİ, DAHA KONTROLLÜ</div><h2>Operasyonunuzun tamamı,<br />tek bakışta.</h2><p>Günün akışını takip edin, sıradaki işleminize geçin.</p></div><router-link to="/terminal" class="welcome-action"><AppIcon name="barcode" :size="36" /><span>Depo operasyonunu başlat</span><AppIcon name="arrow" /></router-link></section>
  <div class="section-heading"><h2>Operasyonlar</h2><span class="muted">Tüm araçlarınız elinizin altında</span></div>
  <div class="operation-grid"><router-link v-for="(item, index) in operations.slice(1)" :key="item.path" :to="item.path" class="operation-card"><span class="operation-icon" :class="'tone-' + index"><AppIcon :name="item.icon" :size="23" /></span><div><h3>{{ item.label }}</h3><p>{{ item.description }}</p></div><AppIcon class="operation-arrow" name="arrow" :size="17" /></router-link></div>
  <div class="section-heading"><h2>Güncel görünüm</h2><button class="subtle" @click="load"><AppIcon name="sync" :size="16" /> Yenile</button></div>
  <div v-if="!data && !error" class="card loading-card" role="status">Operasyon verileri yükleniyor…</div>
  <div v-if="error" class="card" style="border-color: var(--danger)">
    <strong>Hata:</strong> {{ error }}
    <p class="muted">Veriler alınamadı. Bağlantınızı kontrol edip yeniden deneyin.</p><button @click="load">Tekrar dene</button>
  </div>

  <template v-if="data">
    <div class="grid cols-4" style="margin-bottom: 18px">
      <div class="stat">
        <div class="label">USD Kuru</div>
        <div class="value">{{ formatNumber(data.settings.usdExchangeRate, 4) }}</div>
        <div class="muted" style="font-size: 11px">
          {{ data.settings.exchangeRateSource }} · {{ formatDateTime(data.settings.exchangeRateUpdatedAt) }}
        </div>
      </div>
      <div class="stat">
        <div class="label">Kârlılık çarpanı</div>
        <div class="value">x{{ formatNumber(Number(data.settings.targetProfitMarginPercent) / 100) }}</div>
        <div class="muted" style="font-size: 11px">
          maliyetin %{{ formatNumber(data.settings.targetProfitMarginPercent) }} kadari kar
        </div>
      </div>
      <div class="stat">
        <div class="label">Aktif varyant</div>
        <div class="value">{{ data.counts.activeVariants }} / {{ data.counts.variants }}</div>
      </div>
      <div class="stat">
        <div class="label">Bugünkü okutma</div>
        <div class="value">{{ data.counts.scansToday }}</div>
      </div>
      <div class="stat">
        <div class="label">Hesaplanan fiyat</div>
        <div class="value">{{ data.counts.prices }}</div>
      </div>
      <div class="stat">
        <div class="label">Bekleyen aktarım</div>
        <div class="value">{{ data.counts.pendingSync }}</div>
      </div>
      <div class="stat">
        <div class="label">Hatalı aktarım</div>
        <div class="value" :style="data.counts.failedSync ? 'color: var(--danger)' : ''">
          {{ data.counts.failedSync }}
        </div>
      </div>
      <div class="stat">
        <div class="label">Kritik stok (&le;3)</div>
        <div class="value">{{ data.counts.lowStock }}</div>
      </div>
    </div>

    <div class="card">
      <h2>Fiyat işlemleri</h2>
      <div class="row">
        <button class="primary" :disabled="busy" @click="run('recalculate')">Tüm fiyatları yeniden hesapla</button>
        <button :disabled="busy" @click="run('push')">Bekleyen fiyatları işle</button>
        <button :disabled="busy" @click="load">Yenile</button>
        <span v-if="message" class="badge ok">{{ message }}</span>
      </div>
      <p class="muted" style="margin-bottom: 0">
        Fiyatlar arka planda hesaplanır. Sentos bağlantısı salt okunurdur; dış sisteme fiyat yazılmaz.
      </p>
    </div>

    <div class="card" v-if="status">
      <h2>İşlem kuyruğu</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Kuyruk</th>
              <th class="num">Bekleyen</th>
              <th class="num">Aktif</th>
              <th class="num">Gecikmeli</th>
              <th class="num">Hatalı</th>
              <th class="num">Tamamlanan</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="queue in status.queues" :key="queue.queue">
              <td>{{ queue.queue }}</td>
              <td class="num">{{ queue.counts.waiting }}</td>
              <td class="num">{{ queue.counts.active }}</td>
              <td class="num">{{ queue.counts.delayed }}</td>
              <td class="num">{{ queue.counts.failed }}</td>
              <td class="num">{{ queue.counts.completed }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>Son stok hareketleri</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Tarih</th>
              <th>Tip</th>
              <th>Varyant</th>
              <th>Ürün</th>
              <th class="num">Değişim</th>
              <th class="num">Kalan</th>
              <th>Operatör / Referans</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="movement in data.lastMovements" :key="movement.id">
              <td>{{ formatDateTime(movement.createdAt) }}</td>
              <td><span class="badge">{{ MOVEMENT_LABELS[movement.type] ?? movement.type }}</span></td>
              <td>{{ movement.variant.variantCode }}</td>
              <td>{{ movement.variant.product.name }}</td>
              <td class="num">{{ movement.quantityChange }}</td>
              <td class="num">{{ movement.quantityAfter }}</td>
              <td class="muted">{{ movement.operator ?? movement.reference ?? '-' }}</td>
            </tr>
            <tr v-if="!data.lastMovements.length">
              <td colspan="7" class="muted">Henüz stok hareketi bulunmuyor.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </template>
</template>
