import { Decimal, applyRounding, d, type Numeric, type RoundingStrategy } from '../../lib/money.js';

/**
 * MSO Fiyatlandirma Motoru (saf fonksiyon - yan etkisi yoktur, DB bilmez).
 *
 * Iki model destekler:
 *
 * 1) EXCEL_MARKUP (varsayilan) — "Tam Liste" calisma kitabinin birebir karsiligi.
 *    Komisyon tersine bolme ile degil, carpan olarak uygulanir:
 *
 *      Maliyet($)        L = alis + gumruk + navlun
 *      Maliyet(TL)       N = alis > 0 ? L * kur : 0
 *      Hedef fiyat       P = L > 0 ? N * (1 + karlilik) + paketleme : 0
 *      Kargo testi       C = P * (1 + extraFark) * (b+R) * (b+T) * (b+V)     [b = cargoTestBase]
 *      Kargo             K = (C + altKargo) < barem ? altKargo : ustKargo
 *      Satis fiyati      X = (P + K) * (1 + extraFark) * (1+R) * (1+T) * (1+V)
 *      Piyasa fiyati        X * (1 + piyasaFarki)                            [TY / PZRM]
 *      Hakedis           Z = (P + K) * (1 + extraFark) * (1+R) - K
 *      eNyeniler         AV = P * (1 + enyFark) / (1 + enyIndirim) * (enyBase + R)
 *
 *    R = "% Extra ilave", T = komisyon, V = ek komisyon (hepsi oran olarak).
 *
 * 2) REVERSE_COMMISSION — Spesifikasyon V1.0:
 *      Hedef gelir = maliyet + kar payi + fire payi
 *      Fiyat = (hedef gelir + kargo) / (1 - toplam komisyon)
 *
 * Tum islemler Decimal uzerinde yapilir; kayan nokta hatasi olusmaz.
 */

export type PricingModel = 'EXCEL_MARKUP' | 'REVERSE_COMMISSION';

export interface PricingSettingsInput {
  pricingModel?: PricingModel;
  usdExchangeRate: Numeric;
  /** Excel "Karlilik %": x2 => 200 */
  targetProfitMarginPercent: Numeric;
  /** Excel "Birim Paketleme Gideri" */
  packagingCost?: Numeric;
  /** Pazar yeri bazli barem yoksa kullanilan varsayilan esik */
  cargoBaremLimit: Numeric;
  /** Excel "Ust Barem Kargo" */
  upperBaremCargoCost?: Numeric;
  /** Excel "Alt Barem Kargo" */
  lowerBaremCargoCost?: Numeric;
  /** Sadece REVERSE_COMMISSION modelinde kullanilir */
  standardCargoCost?: Numeric;
  /** Excel "eNyeniler Extra Fark" (0.1 => 10) */
  enYenilerExtraMargin: Numeric;
  /** Excel "eNyeniler Extra Indirim" */
  enYenilerDiscountPercent?: Numeric;
  /** Excel kargo baremi testindeki taban carpan (1.019) */
  cargoTestBase?: Numeric;
  /** Excel eNyeniler formulundeki taban carpan (1.018) */
  enYenilerBase?: Numeric;
  priceRoundingStrategy?: RoundingStrategy;
}

export interface PricingVariantInput {
  purchasePriceUsd: Numeric;
  customsTaxUsd: Numeric;
  freightCostUsd: Numeric;
  /** Excel "% Extra ilave" (0.1 => 10) */
  extraLossMargin: Numeric;
  /** REVERSE_COMMISSION modelinde eNyeniler ek karini uygular */
  applyEnYeniler?: boolean;
}

export interface PricingCommissionInput {
  commissionPercent: Numeric;
  extraCommissionPercent: Numeric;
}

export interface MarketplaceConfigInput {
  /** Pazar yerinin kendi kargo baremi; yoksa settings.cargoBaremLimit kullanilir */
  cargoBaremLimit?: Numeric | null;
  /** Excel "Extra Fark" (0.03 => 3) */
  extraFarkPercent?: Numeric;
  /** Excel "Piyasa Fiyati" carpani (0.05 => 5); 0 ise piyasa fiyati uretilmez */
  marketPriceMarkupPercent?: Numeric;
  usesCargo?: boolean;
  usesCommission?: boolean;
  /** eNyeniler kanali kendi formulunu kullanir */
  isEnYeniler?: boolean;
}

export type CargoTier = 'UPPER' | 'LOWER' | 'NONE';

export interface PriceBreakdown {
  model: PricingModel;
  costUsd: Decimal;
  exchangeRateUsed: Decimal;
  costTry: Decimal;
  packagingCost: Decimal;
  profitPercentApplied: Decimal;
  profitAmount: Decimal;
  /** Excel "% Extra ilave" */
  lossPercentApplied: Decimal;
  lossAmount: Decimal;
  /** Excel "Paketleme Dahil Hedef Satis Fiyati" (P) */
  targetRevenue: Decimal;
  /** Kargo baremi testinde kullanilan ara fiyat */
  cargoTestPrice: Decimal;
  cargoBaremLimit: Decimal;
  cargoTier: CargoTier;
  cargoCost: Decimal;
  sellerPaysCargo: boolean;
  extraFarkPercent: Decimal;
  totalCommissionPercent: Decimal;
  commissionAmount: Decimal;
  salePrice: Decimal;
  /** TY / PZRM ustu cizili liste fiyati */
  marketPrice: Decimal | null;
  /** Kargo ve komisyon dusuldukten sonra kasaya kalan (Excel "Hakedis") */
  payoutAmount: Decimal;
  netProfit: Decimal;
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

const HUNDRED = new Decimal(100);
const ONE = new Decimal(1);
const ZERO = new Decimal(0);

/** Yuzde degerini orana cevirir: 16 => 0.16 */
function ratio(value: Numeric | null | undefined): Decimal {
  return d(value).dividedBy(HUNDRED);
}

export function calculatePrice(
  variant: PricingVariantInput,
  commission: PricingCommissionInput,
  settings: PricingSettingsInput,
  marketplace: MarketplaceConfigInput = {},
): PriceBreakdown {
  const model = settings.pricingModel ?? 'EXCEL_MARKUP';
  return model === 'REVERSE_COMMISSION'
    ? calculateReverseCommission(variant, commission, settings, marketplace)
    : calculateExcelMarkup(variant, commission, settings, marketplace);
}

function validate(settings: PricingSettingsInput, commission: PricingCommissionInput) {
  const rate = d(settings.usdExchangeRate);
  if (rate.lte(0)) {
    throw new PricingError('USD kuru 0 veya negatif olamaz. Once kur guncellemesi calistirilmali.');
  }
  if (d(commission.commissionPercent).lt(0) || d(commission.extraCommissionPercent).lt(0)) {
    throw new PricingError('Komisyon oranlari negatif olamaz.');
  }
  return rate;
}

/** Excel calisma kitabinin birebir karsiligi. */
function calculateExcelMarkup(
  variant: PricingVariantInput,
  commission: PricingCommissionInput,
  settings: PricingSettingsInput,
  marketplace: MarketplaceConfigInput,
): PriceBreakdown {
  const rate = validate(settings, commission);

  const purchase = d(variant.purchasePriceUsd);
  const costUsd = purchase.plus(d(variant.customsTaxUsd)).plus(d(variant.freightCostUsd));
  if (costUsd.lt(0)) throw new PricingError('Urun maliyeti negatif olamaz.');

  // Excel: N = IF(NUMBERVALUE(alis); L * kur; 0) — alis fiyati bos ise maliyet 0 kabul edilir.
  const costTry = purchase.gt(0) ? costUsd.times(rate) : ZERO;

  const profitRatio = ratio(settings.targetProfitMarginPercent);
  const packagingCost = d(settings.packagingCost);

  // Excel: P = IF(NUMBERVALUE(L); N * (1 + karlilik) + paketleme; 0)
  const hasCost = costUsd.gt(0);
  const targetRevenue = hasCost ? costTry.times(ONE.plus(profitRatio)).plus(packagingCost) : ZERO;
  const profitAmount = costTry.times(profitRatio);

  const R = ratio(variant.extraLossMargin);
  const T = ratio(commission.commissionPercent);
  const V = ratio(commission.extraCommissionPercent);
  const f = ratio(marketplace.extraFarkPercent ?? 0);

  const usesCommission = marketplace.usesCommission !== false;
  const usesCargo = marketplace.usesCargo !== false;
  const commissionFactor = usesCommission ? ONE.plus(T).times(ONE.plus(V)) : ONE;

  // --- eNyeniler kendi formulunu kullanir ---
  if (marketplace.isEnYeniler) {
    const enyFark = ratio(settings.enYenilerExtraMargin);
    const enyDiscount = ratio(settings.enYenilerDiscountPercent ?? 0);
    const enyBase = d(settings.enYenilerBase ?? 1);

    const raw = hasCost
      ? targetRevenue.times(ONE.plus(enyFark)).dividedBy(ONE.plus(enyDiscount)).times(enyBase.plus(R))
      : ZERO;
    const salePrice = applyRounding(raw, settings.priceRoundingStrategy ?? 'NONE');

    return {
      model: 'EXCEL_MARKUP',
      costUsd,
      exchangeRateUsed: rate,
      costTry,
      packagingCost,
      profitPercentApplied: d(settings.targetProfitMarginPercent),
      profitAmount,
      lossPercentApplied: d(variant.extraLossMargin),
      lossAmount: ZERO,
      targetRevenue,
      cargoTestPrice: ZERO,
      cargoBaremLimit: ZERO,
      cargoTier: 'NONE',
      cargoCost: ZERO,
      sellerPaysCargo: false,
      extraFarkPercent: d(marketplace.extraFarkPercent ?? 0),
      totalCommissionPercent: ZERO,
      commissionAmount: ZERO,
      salePrice,
      marketPrice: null,
      payoutAmount: salePrice,
      netProfit: salePrice.minus(costTry),
    };
  }

  // --- Kargo baremi testi ---
  const base = d(settings.cargoTestBase ?? 1);
  const cargoTestPrice = targetRevenue
    .times(ONE.plus(f))
    .times(base.plus(R))
    .times(usesCommission ? base.plus(T) : ONE)
    .times(usesCommission ? base.plus(V) : ONE);

  const baremLimit = d(marketplace.cargoBaremLimit ?? settings.cargoBaremLimit);
  const lowerCargo = d(settings.lowerBaremCargoCost);
  const upperCargo = d(settings.upperBaremCargoCost);

  // Excel IFS: "< barem" ise alt kargo, degilse ust kargo.
  // (Excel esitlik durumunda #N/A verir; burada ust barem kabul edilir.)
  let cargoTier: CargoTier = 'NONE';
  let cargoCost = ZERO;
  if (usesCargo) {
    const isLower = cargoTestPrice.plus(lowerCargo).lt(baremLimit);
    cargoTier = isLower ? 'LOWER' : 'UPPER';
    cargoCost = isLower ? lowerCargo : upperCargo;
  }

  // --- Satis fiyati ---
  const markup = ONE.plus(f).times(ONE.plus(R)).times(commissionFactor);
  const rawSalePrice = hasCost ? targetRevenue.plus(cargoCost).times(markup) : ZERO;

  const rounding = settings.priceRoundingStrategy ?? 'NONE';
  const salePrice = applyRounding(rawSalePrice, rounding);

  const marketMarkup = ratio(marketplace.marketPriceMarkupPercent ?? 0);
  const marketPrice = marketMarkup.gt(0)
    ? applyRounding(rawSalePrice.times(ONE.plus(marketMarkup)), rounding)
    : null;

  // Hakedis: Excel'de IF korumasi yoktur.
  const payoutAmount = targetRevenue.plus(cargoCost).times(ONE.plus(f)).times(ONE.plus(R)).minus(cargoCost);

  // Komisyon tutari = fiyatin komisyon carpanindan gelen kismi.
  const commissionAmount = usesCommission ? salePrice.minus(salePrice.dividedBy(commissionFactor)) : ZERO;

  // "% Extra ilave"nin fiyata katkisi.
  const withoutR = targetRevenue.plus(cargoCost).times(ONE.plus(f)).times(commissionFactor);
  const lossAmount = hasCost ? withoutR.times(R) : ZERO;

  return {
    model: 'EXCEL_MARKUP',
    costUsd,
    exchangeRateUsed: rate,
    costTry,
    packagingCost,
    profitPercentApplied: d(settings.targetProfitMarginPercent),
    profitAmount,
    lossPercentApplied: d(variant.extraLossMargin),
    lossAmount,
    targetRevenue,
    cargoTestPrice,
    cargoBaremLimit: baremLimit,
    cargoTier,
    cargoCost,
    sellerPaysCargo: cargoCost.gt(0),
    extraFarkPercent: d(marketplace.extraFarkPercent ?? 0),
    totalCommissionPercent: d(commission.commissionPercent).plus(d(commission.extraCommissionPercent)),
    commissionAmount,
    salePrice,
    marketPrice,
    payoutAmount,
    netProfit: payoutAmount.minus(costTry),
  };
}

/** Spesifikasyon V1.0 modeli: komisyon tersine hesaplanir. */
function calculateReverseCommission(
  variant: PricingVariantInput,
  commission: PricingCommissionInput,
  settings: PricingSettingsInput,
  marketplace: MarketplaceConfigInput,
): PriceBreakdown {
  const rate = validate(settings, commission);

  const costUsd = d(variant.purchasePriceUsd)
    .plus(d(variant.customsTaxUsd))
    .plus(d(variant.freightCostUsd));
  if (costUsd.lt(0)) throw new PricingError('Urun maliyeti negatif olamaz.');

  const costTry = costUsd.times(rate);

  let profitPercent = d(settings.targetProfitMarginPercent);
  if (variant.applyEnYeniler) profitPercent = profitPercent.plus(d(settings.enYenilerExtraMargin));

  const lossPercent = d(variant.extraLossMargin);
  const profitAmount = costTry.times(profitPercent).dividedBy(HUNDRED);
  const lossAmount = costTry.times(lossPercent).dividedBy(HUNDRED);
  const targetRevenue = costTry.plus(profitAmount).plus(lossAmount);

  const baremLimit = d(marketplace.cargoBaremLimit ?? settings.cargoBaremLimit);
  const sellerPaysCargo = targetRevenue.gt(baremLimit);
  const cargoCost = sellerPaysCargo ? d(settings.standardCargoCost) : ZERO;

  const totalCommissionPercent = d(commission.commissionPercent).plus(d(commission.extraCommissionPercent));
  if (totalCommissionPercent.gte(HUNDRED)) {
    throw new PricingError(
      `Toplam komisyon %100 veya uzeri olamaz (gelen deger: %${totalCommissionPercent.toString()}).`,
    );
  }

  const divisor = ONE.minus(totalCommissionPercent.dividedBy(HUNDRED));
  const rawSalePrice = targetRevenue.plus(cargoCost).dividedBy(divisor);
  const salePrice = applyRounding(rawSalePrice, settings.priceRoundingStrategy ?? 'ROUND_2');

  const commissionAmount = salePrice.times(totalCommissionPercent).dividedBy(HUNDRED);
  const payoutAmount = salePrice.minus(commissionAmount).minus(cargoCost);

  return {
    model: 'REVERSE_COMMISSION',
    costUsd,
    exchangeRateUsed: rate,
    costTry,
    packagingCost: ZERO,
    profitPercentApplied: profitPercent,
    profitAmount,
    lossPercentApplied: lossPercent,
    lossAmount,
    targetRevenue,
    cargoTestPrice: targetRevenue,
    cargoBaremLimit: baremLimit,
    cargoTier: sellerPaysCargo ? 'UPPER' : 'NONE',
    cargoCost,
    sellerPaysCargo,
    extraFarkPercent: ZERO,
    totalCommissionPercent,
    commissionAmount,
    salePrice,
    marketPrice: null,
    payoutAmount,
    netProfit: payoutAmount.minus(costTry),
  };
}
