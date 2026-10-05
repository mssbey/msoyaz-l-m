<script setup lang="ts">
import { ref } from 'vue';
import { auth, apiErrorMessage } from '../lib/api';
import AppIcon from './AppIcon.vue';
const username = ref(''); const password = ref(''); const visible = ref(false); const busy = ref(false); const error = ref('');
async function submit() {
 if (busy.value) return;
 busy.value = true; error.value = '';
 try { await auth.login(username.value.trim(), password.value); password.value = ''; }
 catch (err) { error.value = apiErrorMessage(err); }
 finally { busy.value = false; }
}
</script>
<template>
 <div class="login-page">
  <section class="login-story">
   <div class="login-brand"><img src="/logo.png" alt="MSO Teknoloji" /><span>OPERASYON PLATFORMU</span></div>
   <div class="story-copy"><div class="eyebrow"><span class="status-dot"></span> İŞİNİZİN KONTROL MERKEZİ</div><h1>Tüm operasyon.<br />Tek bir <em>merkez.</em></h1><p>Ürünlerinizden siparişlerinize, fiyatlandırmadan depo çıkışına kadar her adım bir arada.</p></div>
   <div class="flow-visual" aria-hidden="true"><div class="flow-node"><AppIcon name="orders" :size="26" /><span>Sipariş</span></div><span class="flow-line"></span><div class="flow-node central"><AppIcon name="box" :size="34" /><span>MSO</span></div><span class="flow-line"></span><div class="flow-node"><AppIcon name="barcode" :size="26" /><span>Depo</span></div></div>
   <div class="story-footer"><span>MSO TEKNOLOJİ</span><span>Merkezi yönetim. Kolay operasyon.</span></div>
  </section>
  <section class="login-form-side"><div class="login-form-wrap">
   <div class="login-symbol"><AppIcon name="lock" :size="25" /></div><div class="eyebrow">ÇALIŞMA ALANINIZ</div><h2>Tekrar hoş geldiniz.</h2><p class="login-intro">Operasyonlarınızı yönetmek için hesabınıza giriş yapın.</p>
   <form @submit.prevent="submit">
    <div class="field"><label for="username">Kullanıcı adı</label><div class="input-icon"><AppIcon name="user" /><input id="username" v-model="username" autocomplete="username" placeholder="Kullanıcı adınız" required autofocus :disabled="busy" maxlength="100" /></div></div>
    <div class="field"><label for="password">Şifre</label><div class="input-icon"><AppIcon name="lock" /><input id="password" v-model="password" :type="visible ? 'text' : 'password'" autocomplete="current-password" placeholder="Şifrenizi girin" required :disabled="busy" maxlength="512" /><button type="button" class="password-toggle" :aria-label="visible ? 'Şifreyi gizle' : 'Şifreyi göster'" :aria-pressed="visible" @click="visible = !visible"><AppIcon name="eye" /></button></div></div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <button class="primary login-submit" :disabled="busy" type="submit"><span>{{ busy ? 'Giriş yapılıyor…' : 'Giriş yap' }}</span><AppIcon name="arrow" /></button>
   </form>
   <div class="login-assurance"><AppIcon name="check" :size="16" /> Tek hesapla tüm operasyonlara erişim</div><p class="login-help">Giriş bilgileriniz için sistem yöneticinizle iletişime geçin.</p>
  </div><div class="login-copyright">© {{ new Date().getFullYear() }} MSO Teknoloji · Operasyon Yönetimi</div></section>
 </div>
</template>
