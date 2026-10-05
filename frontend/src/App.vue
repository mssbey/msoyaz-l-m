<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { auth, apiErrorMessage } from './lib/api';
import { operations } from './lib/navigation';
import Login from './components/Login.vue';
import AppIcon from './components/AppIcon.vue';
const route = useRoute();
const mobileOpen = ref(false);
const sessionError = ref('');
const checking = ref(true);
const signingOut = ref(false);
const current = computed(() => operations.find(item => item.path === route.path) ?? operations[0]);
const today = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
watch(() => route.path, () => { mobileOpen.value = false; });
watch([current, () => auth.state.user], () => { document.title = `${auth.state.user ? current.value.label : 'Giriş'} · MSO Teknoloji`; }, { immediate: true });
function handleEscape(event: KeyboardEvent) { if (event.key === 'Escape') mobileOpen.value = false; }
async function checkSession() {
 checking.value = true; sessionError.value = '';
 try { await auth.restore(); } catch (err) { sessionError.value = apiErrorMessage(err); }
 finally { checking.value = false; }
}
async function logout() {
 signingOut.value = true;
 try { await auth.logout(); } catch (err) { sessionError.value = apiErrorMessage(err); }
 finally { signingOut.value = false; }
}
onMounted(() => { void checkSession(); window.addEventListener('keydown', handleEscape); });
onUnmounted(() => window.removeEventListener('keydown', handleEscape));
</script>
<template>
 <div v-if="checking" class="session-loader" role="status"><div class="loader-ring"></div><p>Çalışma alanınız hazırlanıyor…</p></div>
 <div v-else-if="sessionError && !auth.state.user" class="session-loader"><p role="alert">{{ sessionError }}</p><button @click="checkSession">Tekrar dene</button></div>
 <Login v-else-if="!auth.state.user" />
 <div v-else class="layout">
  <a class="skip-link" href="#main">İçeriğe geç</a>
  <button v-if="mobileOpen" class="sidebar-overlay" aria-label="Menüyü kapat" @click="mobileOpen = false"></button>
  <aside class="sidebar" :class="{ 'is-open': mobileOpen }">
   <router-link to="/panel" class="brand-logo"><img src="/logo.png" alt="MSO Teknoloji" /></router-link>
   <div class="brand-sub">OPERASYON YÖNETİMİ</div><div class="nav-label">ÇALIŞMA ALANI</div>
   <nav class="nav" aria-label="Ana menü"><router-link v-for="item in operations" :key="item.path" :to="item.path" :class="{ 'is-active': route.path === item.path }"><AppIcon :name="item.icon" /><span>{{ item.label }}</span><span v-if="item.path === '/terminal'" class="nav-tag">WMS</span></router-link></nav>
   <div class="sidebar-bottom"><div class="workspace-note"><AppIcon name="box" /><div><strong>Her şey bir arada</strong><span>Tek hesap, tüm operasyonlar</span></div></div><div class="user-profile"><span class="avatar">{{ auth.state.user.username.slice(0, 2).toLocaleUpperCase('tr') }}</span><div><strong>{{ auth.state.user.username }}</strong><span>Yönetici</span></div><button class="logout-button" @click="logout" :disabled="signingOut" aria-label="Çıkış yap" title="Çıkış yap"><AppIcon name="logout" /></button></div></div>
  </aside>
  <div class="workspace"><header class="topbar"><div class="breadcrumb"><button class="mobile-menu" aria-label="Menüyü aç" :aria-expanded="mobileOpen" @click="mobileOpen = !mobileOpen"><AppIcon name="menu" /></button><span>Çalışma alanı</span><span class="breadcrumb-divider">/</span><strong>{{ current.label }}</strong></div><span class="topbar-date">{{ today }}</span></header>
   <main class="content" id="main"><div class="page-heading"><div><div class="eyebrow">MSO KONTROL MERKEZİ</div><h1 class="page-title">{{ current.label }}</h1><p class="page-description">{{ current.description }}</p></div><router-link v-if="route.path !== '/terminal'" class="button-link primary" to="/terminal"><AppIcon name="barcode" /> Barkod okut</router-link></div><p v-if="sessionError" role="alert" class="form-error">{{ sessionError }}</p><router-view /></main>
   <footer class="workspace-footer"><span>MSO Teknoloji</span><span>Operasyon Yönetim Platformu</span></footer>
  </div>
 </div>
</template>
