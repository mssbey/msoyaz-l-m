<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { adminApi, apiErrorMessage, formatNumber, formatTry, MARKETPLACE_LABELS } from '../lib/api';

interface Price {
  marketplace: string;
  salePrice: string;
  marketPrice: string | null;
  costTry: string;
  targetRevenue: string;
  cargoCost: string;
  cargoTier: string;
  payoutAmount: string;
  sellerPaysCargo: boolean;
  totalCommissionPercent: string;
  syncStatus: string;
}

interface Variant {
  id: number;
  variantCode: string;
  barcode: string;
  color: string | null;
  size: string | null;
  stockQuantity: number;
  reservedQuantity: number;
  model: string | null;
  purchasePriceUsd: string;
  customsTaxUsd: string;
  freightCostUsd: string;
  extraLossMargin: string;
  commissionPercent: string | null;
  extraCommissionPercent: string | null;
  applyEnYeniler: boolean;
  isActive: boolean;
  product: { name: string; mainProductCode: string; brand: string | null };
  prices: Price[];
}

const items = ref<Variant[]>([]);
const total = ref(0);
const page = ref(1);
const pageCount = ref(1);
const q = ref('');
const lowStock = ref(false);
const loading = ref(false);
const error = ref('');
const expanded = ref<number | null>(null);
const savingId = ref<number | null>(null);

const SYNC_BADGE: Record<string, string> = {
  SUCCESS: 'ok',
  PENDING: 'warn',
  QUEUED: 'warn',
  FAILED: 'err',
  SKIPPED: '',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const response = await adminApi.get('/variants', {
      params: { q: q.value || undefined, lowStock: lowStock.value || undefined, page: page.value, pageSize: 25 },
    });
    items.value = response.data.items;
    total.value = response.data.total;
    pageCount.value = response.data.pageCount;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    loading.value = false;
  }
}

function priceFor(variant: Variant, marketplace: string) {
  return variant.prices.find((price) => price.marketplace === marketplace);
}

/** Maliyet alani degistiginde kaydeder; backend fiyat yeniden hesaplamayi kuyruga atar. */
async function saveCost(variant: Variant) {
  savingId.value = variant.id;
  error.value = '';
  try {
    await adminApi.put(`/variants/${variant.id}`, {
      purchasePriceUsd: String(variant.purchasePriceUsd),
      customsTaxUsd: String(variant.customsTaxUsd),
      freightCostUsd: String(variant.freightCostUsd),
      extraLossMargin: String(variant.extraLossMargin),
      commissionPercent: variant.commissionPercent === null ? null : String(variant.commissionPercent),
      extraCommissionPercent:
        variant.extraCommissionPercent === null ? null : String(variant.extraCommissionPercent),
      applyEnYeniler: variant.applyEnYeniler,
    });
    setTimeout(load, 2000);
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    savingId.value = null;
  }
}

async function saveStock(variant: Variant) {
  savingId.value = variant.id;
  try {
    await adminApi.patch(`/variants/${variant.id}/stock`, {
      newQuantity: Number(variant.stockQuantity),
      note: 'Panelden duzeltme',
    });
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    savingId.value = null;
  }
}

let searchTimer: number | undefined;
watch([q, lowStock], () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    page.value = 1;
    load();
  }, 350);
});

watch(page, load);
onMounted(load);
</script>

<template>
  <div class="card">
    <div class="row">
      <div style="flex: 1; min-width: 220px">
        <label>Ara (varyant kodu, barkod, ürün adı)</label>
        <input v-model="q" placeholder="676OK0022M1 / 8680000000011" />
      </div>
      <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px">
        <input type="checkbox" v-model="lowStock" style="width: auto" /> Sadece kritik stok
      </label>
      <button @click="load" :disabled="loading">Yenile</button>
      <span class="muted">{{ total }} varyant</span>
    </div>
    <div v-if="error" class="badge err">{{ error }}</div>
  </div>

  <div class="card">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Varyant</th>
            <th>Ürün</th>
            <th>Renk / Beden</th>
            <th class="num">Stok</th>
            <th class="num">Rezerve</th>
            <th class="num" v-for="(label, code) in MARKETPLACE_LABELS" :key="code">{{ label }}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="variant in items" :key="variant.id">
            <tr>
              <td>
                <strong>{{ variant.variantCode }}</strong>
                <div class="muted" style="font-size: 11px">{{ variant.barcode }}</div>
              </td>
              <td>{{ variant.product.name }}</td>
              <td class="muted">{{ [variant.color, variant.size].filter(Boolean).join(' / ') || '-' }}</td>
              <td class="num">{{ variant.stockQuantity }}</td>
              <td class="num">{{ variant.reservedQuantity }}</td>
              <td class="num" v-for="(label, code) in MARKETPLACE_LABELS" :key="code">
                <template v-if="priceFor(variant, String(code))">
                  {{ formatTry(priceFor(variant, String(code))!.salePrice) }}
                  <span class="badge" :class="SYNC_BADGE[priceFor(variant, String(code))!.syncStatus]">
                    {{ priceFor(variant, String(code))!.syncStatus }}
                  </span>
                </template>
                <span v-else class="muted">-</span>
              </td>
              <td>
                <button @click="expanded = expanded === variant.id ? null : variant.id">
                  {{ expanded === variant.id ? 'Kapat' : 'Düzenle' }}
                </button>
              </td>
            </tr>

            <tr v-if="expanded === variant.id">
              <td :colspan="6 + Object.keys(MARKETPLACE_LABELS).length" style="background: var(--panel-2)">
                <div class="grid cols-4" style="margin-bottom: 12px">
                  <div>
                    <label>Alış Fiyatı (USD)</label>
                    <input v-model="variant.purchasePriceUsd" />
                  </div>
                  <div>
                    <label>Gümrük (USD)</label>
                    <input v-model="variant.customsTaxUsd" />
                  </div>
                  <div>
                    <label>Navlun (USD)</label>
                    <input v-model="variant.freightCostUsd" />
                  </div>
                  <div>
                    <label>% Extra İlave</label>
                    <input v-model="variant.extraLossMargin" />
                  </div>
                  <div>
                    <label>Komisyon (%)</label>
                    <input v-model="variant.commissionPercent" />
                  </div>
                  <div>
                    <label>Ek Komisyon (%)</label>
                    <input v-model="variant.extraCommissionPercent" />
                  </div>
                  <div>
                    <label>Stok Adedi</label>
                    <input v-model.number="variant.stockQuantity" type="number" min="0" />
                  </div>
                  <div>
                    <label>En Yeniler Ek Kar</label>
                    <select v-model="variant.applyEnYeniler">
                      <option :value="false">Hayir</option>
                      <option :value="true">Evet</option>
                    </select>
                  </div>
                </div>

                <div class="row">
                  <button class="primary" :disabled="savingId === variant.id" @click="saveCost(variant)">
                    Maliyeti Kaydet ve Fiyatı Yenile
                  </button>
                  <button :disabled="savingId === variant.id" @click="saveStock(variant)">Stoğu Kaydet</button>
                  <span class="muted">
                    Maliyet degisiminde fiyat yeniden hesaplama otomatik kuyruga girer.
                  </span>
                </div>

                <div class="table-wrap" style="margin-top: 14px">
                  <table>
                    <thead>
                      <tr>
                        <th>Pazar Yeri</th>
                        <th class="num">Maliyet (TL)</th>
                        <th class="num">Hedef Fiyat</th>
                        <th class="num">Kargo</th>
                        <th class="num">Komisyon %</th>
                        <th class="num">Satış Fiyatı</th>
                        <th class="num">Piyasa Fiyatı</th>
                        <th class="num">Hakediş</th>
                        <th>Aktarım</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="price in variant.prices" :key="price.marketplace">
                        <td>{{ MARKETPLACE_LABELS[price.marketplace] ?? price.marketplace }}</td>
                        <td class="num">{{ formatTry(price.costTry) }}</td>
                        <td class="num">{{ formatTry(price.targetRevenue) }}</td>
                        <td class="num">
                          {{ price.cargoTier === 'NONE' ? '-' : formatTry(price.cargoCost) }}
                          <span v-if="price.cargoTier !== 'NONE'" class="badge">
                            {{ price.cargoTier === 'UPPER' ? 'üst barem' : 'alt barem' }}
                          </span>
                        </td>
                        <td class="num">%{{ formatNumber(price.totalCommissionPercent) }}</td>
                        <td class="num"><strong>{{ formatTry(price.salePrice) }}</strong></td>
                        <td class="num">{{ price.marketPrice ? formatTry(price.marketPrice) : '-' }}</td>
                        <td class="num">{{ formatTry(price.payoutAmount) }}</td>
                        <td><span class="badge" :class="SYNC_BADGE[price.syncStatus]">{{ price.syncStatus }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </template>

          <tr v-if="!items.length && !loading">
            <td :colspan="6 + Object.keys(MARKETPLACE_LABELS).length" class="muted">Kayıt bulunamadi.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="row" style="margin-top: 12px">
      <button :disabled="page <= 1" @click="page--">Önceki</button>
      <span class="muted">Sayfa {{ page }} / {{ pageCount || 1 }}</span>
      <button :disabled="page >= pageCount" @click="page++">Sonraki</button>
    </div>
  </div>
</template>
