<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import AppIcon from '../components/AppIcon.vue';
import { apiErrorMessage, auth, formatDateTime, terminalApi } from '../lib/api';

/**
 * Depo terminali.
 *
 * Iki calisma bicimi:
 *  1. Hızlı çıkış: barkod okutulur, urun bulunur ve stok dusulur.
 *  2. Urun secerek cikis: listeden urun secilir, sonra barkodu okutulur. Okutulan barkod
 *     secili urune ait degilse stok DUSULMEZ ve hata sesi calar (yanlis urun toplama engeli).
 *
 * Yalnızca yerel stok güncellenir; Sentos salt okunur kalır.
 */

interface WarehouseStock {
  warehouseId: number;
  stock: number;
}

interface TerminalVariant {
  id: number;
  variantCode: string;
  barcode: string;
  color: string | null;
  size: string | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  imageUrl: string | null;
  sentosLinked: boolean;
  sentosStockCode: string | null;
  warehouseStocks: WarehouseStock[];
  pendingSentosDelta: number;
  lastSentosError: string | null;
}

interface TerminalItem {
  variant: TerminalVariant;
  product: { name: string; brand: string | null; mainProductCode: string };
}

interface ScanResponse extends TerminalItem {
  ok: boolean;
  message: string;
}

const barcode = ref('');
const quantity = ref(1);
const busy = ref(false);
const result = ref<ScanResponse | null>(null);
const errorText = ref('');
const history = ref<{ code: string; name: string; qty: number; at: string; ok: boolean }[]>([]);
const operator = ref(auth.operator);
const summary = ref<{ scansToday: number; lowStockVariants: number } | null>(null);
const warehouses = ref<{ id: number; name: string }[]>([]);
const inputRef = ref<HTMLInputElement | null>(null);

// --- Urun secimi ---
const searchText = ref('');
const searchResults = ref<TerminalItem[]>([]);
const searching = ref(false);
const selected = ref<TerminalItem | null>(null);
let searchTimer: number | undefined;
let searchVersion = 0;

const mode = computed(() => (selected.value ? 'VERIFY' : 'QUICK'));

let audioContext: AudioContext | null = null;

/** Ses dosyasi yerine osilator: cevrimdisi da calisir, ek varlik gerektirmez. */
function playTone(frequency: number, durationMs: number, type: OscillatorType = 'sine') {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === 'suspended') void audioContext.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.18, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + durationMs / 1000);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + durationMs / 1000);
  } catch {
    /* ses desteklenmiyorsa sessiz devam edilir */
  }
}

function beepSuccess() {
  playTone(1180, 120);
  if ('vibrate' in navigator) navigator.vibrate(60);
}

function beepError() {
  playTone(220, 380, 'square');
  if ('vibrate' in navigator) navigator.vibrate([90, 60, 90]);
}

async function focusInput() {
  await nextTick();
  inputRef.value?.focus();
}

function warehouseName(id: number) {
  return warehouses.value.find((w) => w.id === id)?.name ?? `Depo ${id}`;
}

function variantLabel(v: TerminalVariant) {
  return [v.color, v.size].filter(Boolean).join(' / ');
}

async function scan(code: string) {
  if (!code || busy.value) return;
  const qty = Math.max(1, Math.trunc(Number(quantity.value) || 1));

  busy.value = true;
  errorText.value = '';

  try {
    const { data } = await terminalApi.post<ScanResponse>('/wms/scan', {
      barcode: code,
      quantity: qty,
      ...(selected.value ? { expectedVariantId: selected.value.variant.id } : {}),
    });
    result.value = data;
    history.value.unshift({
      code: data.variant.variantCode,
      name: data.product.name,
      qty,
      at: new Date().toISOString(),
      ok: true,
    });
    // Secili urunun stok bilgisi guncel tutulur (ayni urunden birden fazla cikis yapilabilir).
    if (selected.value) selected.value = { variant: data.variant, product: data.product };
    quantity.value = 1;
    beepSuccess();
    void loadSummary();
  } catch (err) {
    result.value = null;
    errorText.value = apiErrorMessage(err);
    history.value.unshift({ code, name: errorText.value, qty, at: new Date().toISOString(), ok: false });
    beepError();
  } finally {
    history.value = history.value.slice(0, 15);
    barcode.value = '';
    busy.value = false;
    void focusInput();
  }
}

function submit() {
  void scan(barcode.value.trim());
}

/** Etiket okunmuyorsa secili urun barkodsuz dusulebilir (onay ile). */
function dropSelectedWithoutScan() {
  if (!selected.value) return;
  const qty = Math.max(1, Math.trunc(Number(quantity.value) || 1));
  const ok = confirm(`${selected.value.product.name} - ${qty} adet barkod okutmadan stoktan dusulsun mu?`);
  if (ok) void scan(selected.value.variant.barcode);
}

async function runSearch() {
  const q = searchText.value.trim();
  const version = ++searchVersion;
  if (q.length < 2) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  try {
    const { data } = await terminalApi.get<{ items: TerminalItem[] }>('/wms/search', { params: { q, limit: 20 } });
    if (version === searchVersion) searchResults.value = data.items;
  } catch (err) {
    if (version === searchVersion) errorText.value = apiErrorMessage(err);
  } finally {
    if (version === searchVersion) searching.value = false;
  }
}

watch(searchText, () => {
  searchVersion += 1;
  searchResults.value = [];
  searching.value = searchText.value.trim().length >= 2;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 250);
});

function selectItem(item: TerminalItem) {
  if (busy.value) return;
  selected.value = item;
  result.value = null;
  errorText.value = '';
  searchResults.value = [];
  searchText.value = '';
  void focusInput();
}

function clearSelection() {
  if (busy.value) return;
  selected.value = null;
  void focusInput();
}

function stepQuantity(delta: number) {
  quantity.value = Math.max(1, Math.min(999, (Number(quantity.value) || 1) + delta));
}

async function loadSummary() {
  try {
    const { data } = await terminalApi.get('/wms/summary');
    summary.value = data;
  } catch {
    /* ozet gosterimi kritik degil */
  }
}

async function loadWarehouses() {
  try {
    const { data } = await terminalApi.get<{ items: { id: number; name: string }[] }>('/wms/warehouses');
    warehouses.value = data.items;
  } catch {
    /* depo adlari yoksa numara gosterilir */
  }
}

/** Bos alana dokunuldugunda odak barkod alaninda kalir; diger alanlara yazmayi engellemez. */
function keepFocus(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, select, textarea, button, a, .pick-list')) return;
  void focusInput();
}

onMounted(() => {
  void focusInput();
  void loadSummary();
  void loadWarehouses();
  document.addEventListener('click', keepFocus);
});

onUnmounted(() => {
  document.removeEventListener('click', keepFocus);
  window.clearTimeout(searchTimer);
});
</script>

<template>
  <div class="terminal">
    <div class="terminal-toolbar">
      <div class="terminal-status"><span class="status-dot"></span><strong>Okutmaya hazır</strong><span class="muted">Operatör: {{ operator }}</span></div>
      <span class="badge" v-if="summary">Bugün {{ summary.scansToday }} okutma · {{ summary.lowStockVariants }} kritik stok</span>
    </div>

    <div class="terminal-grid">
      <!-- Sol: okutma ve sonuç -->
      <section class="terminal-main">
        <div class="mode-bar" :class="mode === 'VERIFY' ? 'verify' : ''">
          <template v-if="selected">
            <strong>Seçili ürün:</strong> {{ selected.product.name }}
            <span class="muted">({{ selected.variant.variantCode }})</span> — barkodunu okutun
          </template>
          <template v-else>
            <strong>Hızlı çıkış:</strong> okutulan ürün doğrudan yerel stoktan düşülür
          </template>
        </div>

        <!-- Form kullanilir: el okuyucular barkod sonunda Enter gönderir, bu da native submit'i tetikler. -->
        <form class="scan-card" @submit.prevent="submit">
          <div class="section-kicker"><AppIcon name="barcode" /> BARKOD İLE DEPO ÇIKIŞI</div>
          <label for="scan-barcode">Barkod veya stok kodu</label><div class="scan-row">
          <input
            id="scan-barcode"
            ref="inputRef"
            v-model="barcode"
            class="scan-input"
            placeholder="Barkodu okutun veya yazın…"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :disabled="busy"
          />
          <div class="qty">
            <button type="button" :disabled="busy || quantity <= 1" aria-label="Azalt" @click="stepQuantity(-1)">−</button>
            <input v-model.number="quantity" :disabled="busy" type="number" min="1" max="999" step="1" required aria-label="Adet" />
            <button type="button" :disabled="busy || quantity >= 999" aria-label="Artır" @click="stepQuantity(1)">+</button>
          </div>
          </div><div class="scan-footer"><span class="muted">Okuyucu ile okutun veya kodu yazıp Enter’a basın.</span><button type="submit" class="primary" :disabled="busy || !barcode.trim()">{{ busy ? 'İşleniyor…' : 'Stoktan düş' }} <AppIcon name="arrow" :size="16" /></button></div>
        </form>

        <div class="result" :class="{ success: result, error: errorText }" role="status" aria-live="polite">
          <template v-if="result">
            <div class="headline">Çıkış tamamlandı</div>
            <img v-if="result.variant.imageUrl" :src="result.variant.imageUrl" :alt="result.product.name" />
            <div class="product-name">{{ result.product.name }}</div>
            <div class="muted">
              {{ result.variant.variantCode }}
              <template v-if="variantLabel(result.variant)"> · {{ variantLabel(result.variant) }}</template>
            </div>
            <div class="stock">{{ result.variant.stockQuantity }}</div>
            <div class="muted">kalan toplam stok</div>
            <div class="badge ok">Yerel stok güncellendi</div>
            <div class="muted">Sentos’a yazılmaz. Sonraki senkronizasyonda Sentos stoğu esas alınır.</div>
          </template>

          <template v-else-if="errorText">
            <div class="headline">HATA</div>
            <div class="product-name">{{ errorText }}</div>
            <div class="muted">Barkodu tekrar okutun veya yetkiliye bildirin.</div>
          </template>

          <template v-else>
            <div class="scanner-illustration"><AppIcon name="barcode" :size="72" /></div>
            <div class="headline">Bir sonraki ürün hazır mı?</div>
            <div class="muted">Barkodu okutun; ürün bilgisi ve kalan stok burada görünsün.</div>
            <span class="keyboard-hint">Okut → Doğrula → Tamamla</span>
          </template>
        </div>
      </section>

      <!-- Sag: ürün secimi + geçmiş -->
      <aside class="terminal-side">
        <div class="card" style="margin-bottom: 0">
          <h2>Ürün bul ve doğrula</h2><p class="muted">Önce ürünü seçerek yanlış ürün çıkışını önleyin.</p>
          <input aria-label="Ürün ara" v-model="searchText" placeholder="Ürün adı, SKU veya barkod ara…" autocomplete="off" />
          <div v-if="searching" class="muted" style="margin-top: 8px">Aranıyor…</div>
          <ul v-if="searchResults.length" class="pick-list">
            <li v-for="item in searchResults" :key="item.variant.id">
              <button type="button" class="pick-item" @click="selectItem(item)">
                <img v-if="item.variant.imageUrl" :src="item.variant.imageUrl" alt="" />
                <span class="pick-text">
                  <span class="pick-name">{{ item.product.name }}</span>
                  <span class="muted">
                    {{ item.variant.variantCode }}
                    <template v-if="variantLabel(item.variant)"> · {{ variantLabel(item.variant) }}</template>
                    · {{ item.variant.barcode }}
                  </span>
                </span>
                <span class="pick-stock" :class="{ low: item.variant.stockQuantity <= 3 }">
                  {{ item.variant.stockQuantity }}
                </span>
              </button>
            </li>
          </ul>
          <div v-else-if="searchText.trim().length >= 2 && !searching" class="muted" style="margin-top: 8px">
            Aramanızla eşleşen ürün bulunamadı.
          </div>

          <div v-if="selected" class="selected-card">
            <div class="row" style="justify-content: space-between; align-items: flex-start; flex-wrap: nowrap">
              <div>
                <div class="pick-name">{{ selected.product.name }}</div>
                <div class="muted">
                  {{ selected.variant.variantCode }}
                  <template v-if="variantLabel(selected.variant)"> · {{ variantLabel(selected.variant) }}</template>
                </div>
                <div class="muted">Barkod: {{ selected.variant.barcode }}</div>
              </div>
              <div class="selected-stock">{{ selected.variant.stockQuantity }}</div>
            </div>

            <table v-if="selected.variant.warehouseStocks.length" class="wh-table">
              <tbody>
                <tr v-for="row in selected.variant.warehouseStocks" :key="row.warehouseId">
                  <td>{{ warehouseName(row.warehouseId) }}</td>
                  <td class="num">{{ row.stock }}</td>
                </tr>
              </tbody>
            </table>

            <div v-if="selected.variant.lastSentosError" class="badge err" style="white-space: normal">
              Sentos hatası: {{ selected.variant.lastSentosError }}
            </div>
            <div v-else-if="!selected.variant.sentosLinked" class="badge err">Sentos eşleşmesi yok</div>

            <div class="row" style="margin-top: 10px">
              <button type="button" @click="dropSelectedWithoutScan">Barkodsuz çıkış</button>
              <button type="button" class="danger" @click="clearSelection">Seçimi kaldır</button>
            </div>
          </div>
        </div>

        <div class="card" style="margin-bottom: 0">
          <h2>Son okutmalar</h2>
          <table>
            <tbody>
              <tr v-for="(row, index) in history" :key="index">
                <td>{{ formatDateTime(row.at) }}</td>
                <td>
                  <span class="badge" :class="row.ok ? 'ok' : 'err'">{{ row.ok ? `−${row.qty}` : 'HATA' }}</span>
                </td>
                <td>{{ row.code }}</td>
                <td class="muted">{{ row.name }}</td>
              </tr>
              <tr v-if="!history.length"><td class="muted">Henüz okutma yapılmadı. İlk işlem burada görünecek.</td></tr>
            </tbody>
          </table>
        </div>
      </aside>
    </div>
  </div>
</template>
