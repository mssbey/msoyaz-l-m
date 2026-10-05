import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

import Dashboard from './views/Dashboard.vue';
import Products from './views/Products.vue';
import PricingSimulator from './views/PricingSimulator.vue';
import Commissions from './views/Commissions.vue';
import Settings from './views/Settings.vue';
import SyncLogs from './views/SyncLogs.vue';
import Orders from './views/Orders.vue';
import Terminal from './views/Terminal.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/panel' },
    { path: '/:pathMatch(.*)*', redirect: '/panel' },
    { path: '/panel', component: Dashboard, meta: { title: 'Genel Bakis' } },
    { path: '/panel/siparisler', component: Orders, meta: { title: 'Siparisler (Sentos)' } },
    { path: '/panel/urunler', component: Products, meta: { title: 'Urunler ve Fiyatlar' } },
    { path: '/panel/hesaplama', component: PricingSimulator, meta: { title: 'Fiyat Simulatoru' } },
    { path: '/panel/komisyonlar', component: Commissions, meta: { title: 'Pazar Yeri Komisyonlari' } },
    { path: '/panel/ayarlar', component: Settings, meta: { title: 'MSO Ayarlar' } },
    { path: '/panel/senkron', component: SyncLogs, meta: { title: 'Sentos Entegrasyonu' } },
    { path: '/terminal', component: Terminal, meta: { title: 'Depo Terminali' } },
  ],
});

createApp(App).use(router).mount('#app');

// PWA: depo terminalinin cevrimdisi acilabilmesi icin.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* service worker kaydi basarisiz olursa uygulama normal calismaya devam eder */
    });
  });
}
