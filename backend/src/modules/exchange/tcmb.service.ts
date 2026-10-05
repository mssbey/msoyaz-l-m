import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { updateSettings } from '../settings/settings.service.js';

interface TcmbCurrency {
  '@_CurrencyCode'?: string;
  ForexSelling?: string | number;
  ForexBuying?: string | number;
  BanknoteSelling?: string | number;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * TCMB gunluk kur servisinden USD satis kurunu ceker.
 * Hafta sonu / tatil gunlerinde today.xml yayinlanmadigi icin cagri hata verebilir;
 * bu durumda mevcut kur korunur (cagiran taraf hatayi yakalar).
 */
export async function fetchUsdRateFromTcmb(): Promise<{ rate: string; source: string; date?: string }> {
  const response = await axios.get<string>(env.TCMB_URL, {
    timeout: 15000,
    responseType: 'text',
    headers: { 'User-Agent': 'MSO-WMS/1.0' },
  });

  const parsed = parser.parse(response.data) as {
    Tarih_Date?: { Currency?: TcmbCurrency[]; '@_Tarih'?: string };
  };

  const currencies = parsed.Tarih_Date?.Currency ?? [];
  const usd = currencies.find((c) => c['@_CurrencyCode'] === 'USD');

  const rawRate = usd?.ForexSelling ?? usd?.BanknoteSelling ?? usd?.ForexBuying;
  if (!rawRate) {
    throw new Error('TCMB yanitinda USD kuru bulunamadi.');
  }

  const rate = String(rawRate).replace(',', '.');
  if (!Number.isFinite(Number(rate)) || Number(rate) <= 0) {
    throw new Error(`TCMB'den gecersiz kur degeri geldi: ${rawRate}`);
  }

  return { rate, source: 'TCMB', date: parsed.Tarih_Date?.['@_Tarih'] };
}

/**
 * Kuru ceker ve settings tablosuna yazar.
 * triggerRecalculation=false ise (gece CRON zinciri) yeniden hesaplama
 * 03:10 gorevine birakilir; manuel cagride ise observer devreye girer.
 */
export async function syncUsdRate(options: { triggerRecalculation?: boolean } = {}) {
  const { rate, source, date } = await fetchUsdRateFromTcmb();

  const result = await updateSettings(
    { usdExchangeRate: rate, exchangeRateSource: source, exchangeRateUpdatedAt: new Date() },
    { triggerRecalculation: options.triggerRecalculation ?? true },
  );

  logger.info({ rate, date, changed: result.changedFields }, 'USD kuru guncellendi');
  return { rate, date, ...result };
}
