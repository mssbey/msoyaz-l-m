<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { adminApi, apiErrorMessage, formatNumber, MARKETPLACE_LABELS } from '../lib/api';

interface Commission {
  id: number;
  marketplace: string;
  categoryId: string;
  commissionPercent: string;
  extraCommissionPercent: string;
  isActive: boolean;
}

const items = ref<Commission[]>([]);
const error = ref('');
const message = ref('');
const busy = ref(false);

const form = ref({
  marketplace: 'N11',
  categoryId: '*',
  commissionPercent: '16',
  extraCommissionPercent: '3.45',
  isActive: true,
});

async function load() {
  try {
    const { data } = await adminApi.get('/commissions');
    items.value = data.items;
  } catch (err) {
    error.value = apiErrorMessage(err);
  }
}

async function save() {
  busy.value = true;
  message.value = '';
  error.value = '';
  try {
    await adminApi.post('/commissions', {
      ...form.value,
      commissionPercent: String(form.value.commissionPercent),
      extraCommissionPercent: String(form.value.extraCommissionPercent),
    });
    message.value = 'Kaydedildi. Etkilenen tum fiyatlar yeniden hesaplanmak uzere kuyruga alindi.';
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function update(row: Commission) {
  busy.value = true;
  try {
    await adminApi.put(`/commissions/${row.id}`, {
      commissionPercent: String(row.commissionPercent),
      extraCommissionPercent: String(row.extraCommissionPercent),
      isActive: row.isActive,
    });
    message.value = `${row.marketplace} guncellendi, fiyatlar yeniden hesaplanacak.`;
    await load();
  } catch (err) {
    error.value = apiErrorMessage(err);
  } finally {
    busy.value = false;
  }
}

async function remove(row: Commission) {
  if (!confirm(`${row.marketplace} / ${row.categoryId} komisyon tanimi silinsin mi?`)) return;
  busy.value = true;
  try {
    await adminApi.delete(`/commissions/${row.id}`);
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
    <h2>Yeni / Güncelle</h2>
    <div class="row">
      <div style="min-width: 160px">
        <label>Pazar Yeri</label>
        <select v-model="form.marketplace">
          <option v-for="(label, code) in MARKETPLACE_LABELS" :key="code" :value="code">{{ label }}</option>
        </select>
      </div>
      <div style="min-width: 160px">
        <label>Kategori ("*" = varsayilan)</label>
        <input v-model="form.categoryId" />
      </div>
      <div style="min-width: 120px">
        <label>Komisyon (%)</label>
        <input v-model="form.commissionPercent" />
      </div>
      <div style="min-width: 140px">
        <label>Ekstra Komisyon (%)</label>
        <input v-model="form.extraCommissionPercent" />
      </div>
      <button class="primary" :disabled="busy" @click="save">Kaydet</button>
    </div>
    <p v-if="message" class="badge ok" style="margin-top: 12px; display: inline-block">{{ message }}</p>
    <p v-if="error" class="badge err" style="margin-top: 12px; display: inline-block">{{ error }}</p>
  </div>

  <div class="card">
    <h2>Tanimli Komisyonlar</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pazar Yeri</th>
            <th>Kategori</th>
            <th class="num">Komisyon %</th>
            <th class="num">Ekstra %</th>
            <th class="num">Toplam %</th>
            <th>Aktif</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in items" :key="row.id">
            <td>{{ MARKETPLACE_LABELS[row.marketplace] ?? row.marketplace }}</td>
            <td>{{ row.categoryId }}</td>
            <td class="num"><input v-model="row.commissionPercent" style="width: 90px; text-align: right" /></td>
            <td class="num"><input v-model="row.extraCommissionPercent" style="width: 90px; text-align: right" /></td>
            <td class="num">
              %{{ formatNumber(Number(row.commissionPercent) + Number(row.extraCommissionPercent)) }}
            </td>
            <td><input type="checkbox" v-model="row.isActive" style="width: auto" /></td>
            <td>
              <button :disabled="busy" @click="update(row)">Güncelle</button>
              <button class="danger" :disabled="busy" style="margin-left: 6px" @click="remove(row)">Sil</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
