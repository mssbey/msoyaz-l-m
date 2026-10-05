<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, apiErrorMessage, formatDateTime, MARKETPLACE_LABELS } from '../lib/api';

interface MarketplaceSetting {
  marketplace: string;
  cargoBaremLimit: string;
  extraFarkPercent: string;
  marketPriceMarkupPercent: string;
  usesCargo: boolean;
  usesCommission: boolean;
  isActive: boolean;
}

const form = ref({
  pricingModel: 'EXCEL_MARKUP',
  usdExchangeRate: '',
  targetProfitMarginPercent: '',
  packagingCost: '',
  cargoBaremLimit: '',
  upperBaremCargoCost: '',
  lowerBaremCargoCost: '',
  standardCargoCost: '',
  enYenilerExtraMargin: '',
  enYenilerDiscountPercent: '',
  cargoTestBase: '',
  enYenilerBase: '',
  priceRoundingStrategy: 'NONE',
});

const marketplaces = ref<MarketplaceSetting[]>([]);
const meta = ref<{ exchangeRateSource: string | null; exchangeRateUpdatedAt: string | null } | null>(null);
const message = ref('');
const error = ref('');
const busy = ref(false);

async function load() {
  try {
    const [settings, mp] = await Promise.all([
      adminApi.get('/settings'),
      adminApi.get('/marketplace-settings'),
    ]);
    const data = settings.data;
    form.value = {
      pricingModel: data.pricingModel,
      usdExchangeRate: data.usdExchangeRate,
      targetProfitMarginPercent: data.targetProfitMarginPercent,
      packagingCost: data.packagingCost,
      cargoBaremLimit: data.cargoBaremLimit,
      upperBaremCargoCost: data.upperBaremCargoCost,
      lowerBaremCargoCost: data.lowerBaremCargoCost,
      standardCargoCost: data.standardCargoCost,
      enYenilerExtraMargin: data.enYenilerExtraMargin,
      enYenilerDiscountPercent: data.enYenilerDiscountPercent,
      cargoTestBase: data.cargoTestBase,
      enYenilerBase: data.enYenilerBase,
      priceRoundingStrategy: data.priceRoundingStrategy,
    };
    meta.value = { exchangeRateSource: data.exchangeRateSource, exchangeRateUpdatedAt: data.exchangeRateUpdatedAt };
    marketplaces.value = mp.data.items;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function save() {
  busy.value = true;
  message.value = '';
  error.value = '';
  try {
    const { data } = await adminApi.put('/settings', form.value);
    message.value = data.recalculationQueued
      ? `Kaydedildi. Degisen alanlar: ${data.changedFields.join(', ')}. Tum fiyatlar yeniden hesaplanmak uzere kuyruga alindi.`
      : 'Kaydedildi. Fiyati etkileyen bir degisiklik olmadigi icin yeniden hesaplama tetiklenmedi.';
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function saveMarketplace(row: MarketplaceSetting) {
  busy.value = true;
  message.value = '';
  try {
    await adminApi.put(`/marketplace-settings/${row.marketplace}`, {
      cargoBaremLimit: String(row.cargoBaremLimit),
      extraFarkPercent: String(row.extraFarkPercent),
      marketPriceMarkupPercent: String(row.marketPriceMarkupPercent),
      usesCargo: row.usesCargo,
      usesCommission: row.usesCommission,
      isActive: row.isActive,
    });
    message.value = `${row.marketplace} guncellendi; fiyatlar yeniden hesaplanacak.`;
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function syncRate() {
  busy.value = true;
  message.value = '';
  error.value = '';
  try {
    const { data } = await adminApi.post('/settings/exchange-rate/sync');
    message.value = `TCMB kuru guncellendi: ${data.rate}`;
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="card">
    <h2>Fiyat Modeli</h2>
    <div class="row">
      <div style="min-width: 320px">
        <label>Hesaplama modeli</label>
        <select v-model="form.pricingModel">
          <option value="EXCEL_MARKUP">Excel modeli (komisyon carpan olarak eklenir)</option>
          <option value="REVERSE_COMMISSION">Spesifikasyon V1.0 (komisyon tersine hesaplanir)</option>
        </select>
      </div>
      <div style="min-width: 200px">
        <label>Fiyat yuvarlama</label>
        <select v-model="form.priceRoundingStrategy">
          <option value="NONE">Yuvarlama yok (Excel ile birebir)</option>
          <option value="ROUND_2">2 haneye yuvarla</option>
          <option value="PSYCHOLOGICAL_99">Psikolojik (x.99)</option>
        </select>
      </div>
    </div>
    <p class="muted" style="margin-bottom: 0">
      Excel modeli: fiyat = (hedef fiyat + kargo) x (1 + extra fark) x (1 + % extra ilave) x (1 + komisyon) x
      (1 + ek komisyon). Yuvarlama "yok" seçili oldugunda sonuclar calisma kitabiyla birebir ayni cikar.
    </p>
  </div>

  <div class="card">
    <h2>Global Ayarlar (MSO Ayarlar)</h2>

    <div class="grid cols-3">
      <div class="field">
        <label>USD Kuru</label>
        <input v-model="form.usdExchangeRate" />
        <div class="muted" style="font-size: 11px; margin-top: 4px">
          {{ meta?.exchangeRateSource ?? '-' }} · {{ formatDateTime(meta?.exchangeRateUpdatedAt) }}
        </div>
      </div>
      <div class="field">
        <label>Kârlılık (%) — Excel'de x2 = 200</label>
        <input v-model="form.targetProfitMarginPercent" />
      </div>
      <div class="field">
        <label>Birim Paketleme Gideri (TL)</label>
        <input v-model="form.packagingCost" />
      </div>
      <div class="field">
        <label>STD Kargo Baremi (TL)</label>
        <input v-model="form.cargoBaremLimit" />
      </div>
      <div class="field">
        <label>Üst Barem Kargo (TL)</label>
        <input v-model="form.upperBaremCargoCost" />
      </div>
      <div class="field">
        <label>Alt Barem Kargo (TL)</label>
        <input v-model="form.lowerBaremCargoCost" />
      </div>
      <div class="field">
        <label>eNyeniler Extra Fark (%)</label>
        <input v-model="form.enYenilerExtraMargin" />
      </div>
      <div class="field">
        <label>eNyeniler Extra İndirim (%)</label>
        <input v-model="form.enYenilerDiscountPercent" />
      </div>
      <div class="field">
        <label>Kargo testi taban çarpanı</label>
        <input v-model="form.cargoTestBase" />
      </div>
      <div class="field">
        <label>eNyeniler taban çarpanı</label>
        <input v-model="form.enYenilerBase" />
      </div>
      <div class="field">
        <label>Standart Kargo (yalnızca V1.0 modeli)</label>
        <input v-model="form.standardCargoCost" />
      </div>
    </div>

    <div class="row" style="margin-top: 8px">
      <button class="primary" :disabled="busy" @click="save">Kaydet</button>
      <button :disabled="busy" @click="syncRate">TCMB'den Kuru Çek</button>
    </div>

    <p v-if="message" class="badge ok" style="margin-top: 12px; display: inline-block">{{ message }}</p>
    <p v-if="error" class="badge err" style="margin-top: 12px; display: inline-block">{{ error }}</p>

    <p class="muted">
        Bu alanlardan biri değiştiğinde sistem tüm varyantların fiyatlarını arka planda
        yeniden hesaplar. Sentos bağlantısı salt okunurdur; dış sisteme fiyat yazılmaz.
    </p>
  </div>

  <div class="card">
    <h2>Pazar Yeri Parametreleri</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pazar Yeri</th>
            <th class="num">Kargo Baremi</th>
            <th class="num">Extra Fark (%)</th>
            <th class="num">Piyasa Fiyatı (%)</th>
            <th>Kargo</th>
            <th>Komisyon</th>
            <th>Aktif</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in marketplaces" :key="row.marketplace">
            <td>{{ MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace }}</td>
            <td class="num"><input v-model="row.cargoBaremLimit" style="width: 100px; text-align: right" /></td>
            <td class="num"><input v-model="row.extraFarkPercent" style="width: 90px; text-align: right" /></td>
            <td class="num">
              <input v-model="row.marketPriceMarkupPercent" style="width: 90px; text-align: right" />
            </td>
            <td><input type="checkbox" v-model="row.usesCargo" style="width: auto" /></td>
            <td><input type="checkbox" v-model="row.usesCommission" style="width: auto" /></td>
            <td><input type="checkbox" v-model="row.isActive" style="width: auto" /></td>
            <td><button :disabled="busy" @click="saveMarketplace(row)">Güncelle</button></td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="muted" style="margin-bottom: 0">
      "Piyasa Fiyatı", Trendyol ve Pazarama'da gösterilen üstü cizili liste fiyatini uretir.
      eNyeniler kanali kargo ve komisyon kullanmaz; kendi formuluyle hesaplanir.
    </p>
  </div>

  <div class="card">
    <h2>Otomatik Görevler</h2>
    <table>
      <thead>
        <tr><th>Saat</th><th>Görev</th></tr>
      </thead>
      <tbody>
        <tr><td>03:00</td><td>TCMB'den güncel USD kuru çekilir</td></tr>
        <tr><td>03:10</td><td>Tüm varyantlarin pazar yeri fiyatları yeniden hesaplanir</td></tr>
        <tr><td>03:30</td><td>Değişen fiyatlar Sentos kuyruguna alinir</td></tr>
        <tr><td>Her 15 dk</td><td>Sentos ile stok mutabakati yapilir</td></tr>
      </tbody>
    </table>
  </div>
</template>
