import axios from 'axios';
import { reactive } from 'vue';

type User = { username: string; role: 'ADMIN' };
const state = reactive<{ user: User | null }>({ user: null });
const sessionApi = axios.create({ baseURL: '/api/auth', timeout: 15000, headers: { 'x-mso-client': 'web' } });
// Remove credentials retained by the previous API-key login screen.
for (const key of ['mso_admin_key', 'mso_terminal_key', 'mso_operator']) localStorage.removeItem(key);
export const auth = {
  state,
  get operator() { return state.user?.username ?? ''; },
  async restore() {
    try { state.user = (await sessionApi.get('/me')).data.user; }
    catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) state.user = null;
      else throw err;
    }
  },
  async login(username: string, password: string) {
    state.user = (await sessionApi.post('/login', { username, password })).data.user;
  },
  async logout() {
    await sessionApi.post('/logout');
    state.user = null;
  },
};
export const adminApi = axios.create({ baseURL: '/api', timeout: 30000, headers: { 'x-mso-client': 'web' } });
adminApi.interceptors.response.use(response => response, error => {
  if (axios.isAxiosError(error) && error.response?.status === 401) state.user = null;
  return Promise.reject(error);
});
export const terminalApi = adminApi;

export function apiErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return (err.response?.data as { error?: string })?.error ?? err.message;
  }
  return (err as Error)?.message ?? 'Bilinmeyen hata';
}

export const MARKETPLACE_LABELS: Record<string, string> = {
  STD: 'Standart',
  N11: 'N11',
  HB: 'Hepsiburada',
  TY: 'Trendyol',
  PZRM: 'Pazarama',
  ENY: 'eNyeniler',
};

/** Ustu cizili "piyasa fiyati" ureten kanallar. */
export const MARKET_PRICE_CHANNELS = ['TY', 'PZRM'];

export function formatTry(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  return new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(Number(value));
}

export function formatNumber(value: string | number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || value === '') return '-';
  return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(
    Number(value),
  );
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('tr-TR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}
