<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { adminApi, apiErrorMessage, formatNumber, formatTry, MARKETPLACE_LABELS } from '../lib/api';

/**
 * Reaktif fiyat simulatoru: alanlar degistikce backend'deki ayni motoru cagirir.
 * Hicbir kayit yapilmaz; "ya sunu yapsak" senaryolari icin.
 */

interface MarketplaceSetting {
  marketplace: string;
  cargoBaremLimit: string;
  extraFarkPercent: string;
  marketPriceMarkupPercent: string;
  usesCargo: boolean;
  usesCommission: boolean;
}

const marketplaces = ref<MarketplaceSetting[]>([]);
const selected = ref('STD');

const form = ref({
  purchasePriceUsd: '1.2',
  customsTaxUsd: '0.1',
  freightCostUsd: '0',
  extraLossMargin: '0',
  commissionPercent: '16',
  extraCommissionPercent: '3.451',
  usdExchangeRate: '',
  targetProfitMarginPercent: '',
  packagingCost: '',
  upperBaremCargoCost: '',
  lowerBaremCargoCost: '',
  priceRoundingStrategy: '' as '' | 'NONE' | 'ROUND_2' | 'PSYCHOLOGICAL_99',
});

const breakdown = ref<Record<string, string | boolean | null> | null>(null);
const usedSettings = ref<Record<string, string> | null>(null);
const error = ref('');
const loading = ref(false);

/** Varyant kodu ile mevcut bir urunu forma yukler. */
const lookupCode = ref('');
async function loadVariant() {
  if (!lookupCode.value.trim()) return;
  error.value = '';
  try {
    const { data } = await adminApi.get('/variants', { params: { q: lookupCode.value.trim(), pageSize: 1 } });
    const variant = data.items?.[0];
    if (!variant) {
      error.value = 'Varyant bulunamadi.';
      return;
    }
    form.value.purchasePriceUsd = variant.purchasePriceUsd;
    form.value.customsTaxUsd = variant.customsTaxUsd;
    form.value.freightCostUsd = variant.freightCostUsd;
    form.value.extraLossMargin = variant.extraLossMargin;
    if (variant.commissionPercent) form.value.commissionPercent = variant.commissionPercent;
    if (variant.extraCommissionPercent) form.value.extraCommissionPercent = variant.extraCommissionPercent;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function calculate() {
  loading.value = true;
  error.value = '';
  try {
    const settings: Record<string, string> = {};
    for (const key of [
      'usdExchangeRate',
      'targetProfitMarginPercent',
      'packagingCost',
      'upperBaremCargoCost',
      'lowerBaremCargoCost',
      'priceRoundingStrategy',
    ] as const) {
      const value = form.value[key];
      if (value !== '' && value !== null) settings[key] = String(value);
    }

    const mp = marketplaces.value.find((row) => row.marketplace === selected.value);

    const { data } = await adminApi.post('/pricing/simulate', {
      variant: {
        purchasePriceUsd: form.value.purchasePriceUsd,
        customsTaxUsd: form.value.customsTaxUsd,
        freightCostUsd: form.value.freightCostUsd,
        extraLossMargin: form.value.extraLossMargin,
      },
      commission: {
        commissionPercent: form.value.commissionPercent,
        extraCommissionPercent: form.value.extraCommissionPercent,
      },
      settings: Object.keys(settings).length ? settings : undefined,
      marketplace: mp
        ? {
            cargoBaremLimit: mp.cargoBaremLimit,
            extraFarkPercent: mp.extraFarkPercent,
            marketPriceMarkupPercent: mp.marketPriceMarkupPercent,
            usesCargo: mp.usesCargo,
            usesCommission: mp.usesCommission,
            isEnYeniler: mp.marketplace === 'ENY',
          }
        : undefined,
    });

    breakdown.value = data.breakdown;
    usedSettings.value = data.settings;
  } catch (err) {
    error.value = apiErrorMessage(err);
    breakdown.value = null;
  } finally {
    loading.value = false;
  }
}

let timer: number | undefined;
watch(
  [form, selected],
  () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(calculate, 250);
  },
  { deep: true },
);

onMounted(async () => {
  try {
    const { data } = await adminApi.get('/marketplace-settings');
    marketplaces.value = data.items;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
  await calculate();
});
</script>

<template>
  <div class="grid cols-2">
    <div class="card">
      <h2>Girdiler</h2>

      <div class="row" style="margin-bottom: 14px">
        <div style="flex: 1; min-width: 200px">
          <label>Mevcut varyanttan doldur</label>
          <input v-model="lookupCode" placeholder="676OK0022M1" @keyup.enter="loadVariant" />
        </div>
        <button @click="loadVariant">Yukle</button>
      </div>

      <div class="grid cols-2">
        <div class="field">
          <label>Pazar Yeri</label>
          <select v-model="selected">
            <option v-for="row in marketplaces" :key="row.marketplace" :value="row.marketplace">
              {{ MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>Nakliye Dahil Alış (USD)</label>
          <input v-model="form.purchasePriceUsd" />
        </div>
        <div class="field">
          <label>KDV Dahil Gümrük (USD)</label>
          <input v-model="form.customsTaxUsd" />
        </div>
        <div class="field">
          <label>Ek Navlun (USD)</label>
          <input v-model="form.freightCostUsd" />
        </div>
        <div class="field">
          <label>% Extra ilave</label>
          <input v-model="form.extraLossMargin" />
        </div>
        <div class="field">
          <label>Komisyon (%)</label>
          <input v-model="form.commissionPercent" />
        </div>
        <div class="field">
          <label>Ek Komisyon (%)</label>
          <input v-model="form.extraCommissionPercent" />
        </div>
      </div>

      <h2 style="margin-top: 18px">Ayar Geçersiz Kilma (boş = sistem ayari)</h2>
      <div class="grid cols-2">
        <div class="field">
          <label>USD Kuru</label>
          <input v-model="form.usdExchangeRate" placeholder="sistem ayari" />
        </div>
        <div class="field">
          <label>Kârlılık (%)</label>
          <input v-model="form.targetProfitMarginPercent" placeholder="sistem ayari" />
        </div>
        <div class="field">
          <label>Paketleme Gideri (TL)</label>
          <input v-model="form.packagingCost" placeholder="sistem ayari" />
        </div>
        <div class="field">
          <label>Üst Barem Kargo (TL)</label>
          <input v-model="form.upperBaremCargoCost" placeholder="sistem ayari" />
        </div>
        <div class="field">
          <label>Alt Barem Kargo (TL)</label>
          <input v-model="form.lowerBaremCargoCost" placeholder="sistem ayari" />
        </div>
        <div class="field">
          <label>Yuvarlama</label>
          <select v-model="form.priceRoundingStrategy">
            <option value="">Sistem ayari</option>
            <option value="NONE">Yuvarlama yok</option>
            <option value="ROUND_2">2 haneye yuvarla</option>
            <option value="PSYCHOLOGICAL_99">Psikolojik (x.99)</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Sonuç <span v-if="loading" class="muted">(hesaplaniyor...)</span></h2>

      <div v-if="error" class="badge err">{{ error }}</div>

      <template v-if="breakdown">
        <div class="grid cols-2" style="margin-bottom: 14px">
          <div class="stat">
            <div class="label">Satış Fiyatı ({{ MARKETPLACE_LABELS[selected] ?? selected }})</div>
            <div class="value" style="color: var(--accent)">{{ formatTry(breakdown.salePrice as string) }}</div>
          </div>
          <div class="stat">
            <div class="label">Hakediş (kasaya kalan)</div>
            <div class="value">{{ formatTry(breakdown.payoutAmount as string) }}</div>
          </div>
        </div>

        <table>
          <tbody>
            <tr>
              <td>Toplam Maliyet (USD)</td>
              <td class="num">{{ formatNumber(breakdown.costUsd as string, 4) }} $</td>
            </tr>
            <tr>
              <td>Kullanilan Kur</td>
              <td class="num">{{ formatNumber(breakdown.exchangeRateUsed as string, 4) }}</td>
            </tr>
            <tr>
              <td><strong>1. Maliyet (TL)</strong></td>
              <td class="num">{{ formatTry(breakdown.costTry as string) }}</td>
            </tr>
            <tr>
              <td>Kârlılık (%{{ formatNumber(breakdown.profitPercentApplied as string) }})</td>
              <td class="num">+ {{ formatTry(breakdown.profitAmount as string) }}</td>
            </tr>
            <tr>
              <td>Paketleme gideri</td>
              <td class="num">+ {{ formatTry(breakdown.packagingCost as string) }}</td>
            </tr>
            <tr>
              <td><strong>2. Hedef Satış Fiyatı</strong></td>
              <td class="num"><strong>{{ formatTry(breakdown.targetRevenue as string) }}</strong></td>
            </tr>
            <tr>
              <td>
                3. Kargo baremi testi
                <span class="muted">(esik {{ formatTry(breakdown.cargoBaremLimit as string) }})</span>
              </td>
              <td class="num">{{ formatTry(breakdown.cargoTestPrice as string) }}</td>
            </tr>
            <tr>
              <td>
                Kargo
                <span class="badge" :class="breakdown.cargoTier === 'UPPER' ? 'warn' : 'ok'">
                  {{
                    breakdown.cargoTier === 'UPPER'
                      ? 'üst barem'
                      : breakdown.cargoTier === 'LOWER'
                        ? 'alt barem'
                        : 'kargo yok'
                  }}
                </span>
              </td>
              <td class="num">+ {{ formatTry(breakdown.cargoCost as string) }}</td>
            </tr>
            <tr v-if="Number(breakdown.extraFarkPercent) > 0">
              <td>4. Pazar yeri extra farki</td>
              <td class="num">%{{ formatNumber(breakdown.extraFarkPercent as string) }}</td>
            </tr>
            <tr v-if="Number(breakdown.lossPercentApplied) > 0">
              <td>% Extra ilave (%{{ formatNumber(breakdown.lossPercentApplied as string) }})</td>
              <td class="num">+ {{ formatTry(breakdown.lossAmount as string) }}</td>
            </tr>
            <tr>
              <td>Komisyon çarpanı (%{{ formatNumber(breakdown.totalCommissionPercent as string) }})</td>
              <td class="num">+ {{ formatTry(breakdown.commissionAmount as string) }}</td>
            </tr>
            <tr>
              <td><strong>Satış Fiyatı</strong></td>
              <td class="num"><strong>{{ formatTry(breakdown.salePrice as string) }}</strong></td>
            </tr>
            <tr v-if="breakdown.marketPrice">
              <td>Piyasa Fiyatı (üstü cizili)</td>
              <td class="num">{{ formatTry(breakdown.marketPrice as string) }}</td>
            </tr>
            <tr>
              <td>Net Kar (hakediş - maliyet)</td>
              <td class="num" style="color: #86efac">{{ formatTry(breakdown.netProfit as string) }}</td>
            </tr>
          </tbody>
        </table>

        <p class="muted" style="margin-bottom: 0">
          Model: <strong>{{ breakdown.model }}</strong
          >. Excel modelinde komisyon fiyata carpan olarak eklenir; hakediş
          (hedef fiyat + kargo) x (1 + extra fark) x (1 + % extra ilave) - kargo olarak bulunur.
        </p>
      </template>
    </div>
  </div>
</template>
