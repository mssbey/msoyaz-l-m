import assert from 'node:assert/strict';
import { calculatePrice, PricingError } from './pricing.engine.js';

/**
 * Fiyat motoru dogrulama testleri.
 * Calistirma: npm run test:pricing
 *
 * EXCEL_MARKUP beklentileri "Tam Liste-27.xlsx" dosyasindaki gercek satirlardan alinmistir
 * (676OK0022M1: alis 1.2$, gumruk 0.1$, kur 44, karlilik x2, paketleme 25).
 */

const excelSettings = {
  pricingModel: 'EXCEL_MARKUP' as const,
  usdExchangeRate: 44,
  targetProfitMarginPercent: 200,
  packagingCost: 25,
  cargoBaremLimit: 300,
  upperBaremCargoCost: 100,
  lowerBaremCargoCost: 85,
  enYenilerExtraMargin: 10,
  enYenilerDiscountPercent: 0,
  cargoTestBase: 1.019,
  enYenilerBase: 1.018,
  priceRoundingStrategy: 'NONE' as const,
};

const specSettings = {
  pricingModel: 'REVERSE_COMMISSION' as const,
  usdExchangeRate: 34,
  targetProfitMarginPercent: 44,
  cargoBaremLimit: 300,
  standardCargoCost: 60,
  enYenilerExtraMargin: 0.1,
  priceRoundingStrategy: 'ROUND_2' as const,
};

const excelVariant = {
  purchasePriceUsd: 1.2,
  customsTaxUsd: 0.1,
  freightCostUsd: 0,
  extraLossMargin: 0,
};

const excelCommission = { commissionPercent: 16, extraCommissionPercent: 3.45 };

const tests: { name: string; run: () => void }[] = [];
function test(name: string, run: () => void) {
  tests.push({ name, run });
}

// --------------------------------------------------------------- EXCEL_MARKUP

test('EXCEL: maliyet, hedef fiyat ve barem ustu kargo', () => {
  const b = calculatePrice(excelVariant, excelCommission, excelSettings, { extraFarkPercent: 0 });

  assert.equal(b.costUsd.toFixed(4), '1.3000');
  assert.equal(b.costTry.toFixed(4), '57.2000'); // 1.3 * 44
  assert.equal(b.targetRevenue.toFixed(4), '196.6000'); // 57.2 * 3 + 25
  assert.equal(b.cargoTestPrice.toFixed(6), '248.831892'); // 196.6 * 1.019 * 1.179 * 1.0535
  assert.equal(b.cargoTier, 'UPPER'); // 248.83 + 85 > 300
  assert.equal(b.cargoCost.toFixed(2), '100.00');
});

test('EXCEL: STD satis fiyati Excel ile birebir', () => {
  const b = calculatePrice(excelVariant, excelCommission, excelSettings, {});
  // (196.6 + 100) * 1.16 * 1.0345
  assert.equal(b.salePrice.toFixed(6), '355.925932');
  assert.equal(b.payoutAmount.toFixed(4), '196.6000');
  assert.equal(b.marketPrice, null);
});

test('EXCEL: TY piyasa fiyati = satis fiyati * (1 + piyasa farki)', () => {
  const b = calculatePrice(excelVariant, excelCommission, excelSettings, {
    marketPriceMarkupPercent: 5,
  });
  assert.equal(b.salePrice.toFixed(6), '355.925932');
  assert.equal(b.marketPrice!.toFixed(6), '373.722229'); // 373.7222286
});

test('EXCEL: eNyeniler kendi formulunu kullanir', () => {
  const b = calculatePrice(excelVariant, excelCommission, excelSettings, {
    isEnYeniler: true,
    usesCargo: false,
    usesCommission: false,
  });
  // 196.6 * 1.1 / 1 * 1.018
  assert.equal(b.salePrice.toFixed(5), '220.15268');
  assert.equal(b.cargoCost.toFixed(2), '0.00');
  assert.equal(b.commissionAmount.toFixed(2), '0.00');
});

test('EXCEL: alis fiyati bos ise maliyet 0, hedef fiyat sadece paketleme', () => {
  const b = calculatePrice(
    { purchasePriceUsd: 0, customsTaxUsd: 0.1, freightCostUsd: 0, extraLossMargin: 0 },
    excelCommission,
    excelSettings,
    {},
  );
  assert.equal(b.costTry.toFixed(2), '0.00'); // Excel: IF(NUMBERVALUE(alis); ...; 0)
  assert.equal(b.targetRevenue.toFixed(2), '25.00'); // 0 * 3 + 25
  assert.equal(b.cargoTier, 'LOWER'); // 25 uzerinden test barem altinda kalir
  assert.equal(b.cargoCost.toFixed(2), '85.00');
});

test('EXCEL: maliyet tamamen bos ise fiyat 0', () => {
  const b = calculatePrice(
    { purchasePriceUsd: 0, customsTaxUsd: 0, freightCostUsd: 0, extraLossMargin: 0 },
    excelCommission,
    excelSettings,
    {},
  );
  assert.equal(b.targetRevenue.toFixed(2), '0.00');
  assert.equal(b.salePrice.toFixed(2), '0.00');
});

test('EXCEL: "% Extra ilave" fiyati artirir', () => {
  const withExtra = calculatePrice(
    { ...excelVariant, extraLossMargin: 10 },
    excelCommission,
    excelSettings,
    {},
  );
  const without = calculatePrice(excelVariant, excelCommission, excelSettings, {});
  assert.ok(withExtra.salePrice.gt(without.salePrice));
  assert.ok(withExtra.lossAmount.gt(0));
});

test('EXCEL: pazar yeri extra farki fiyata carpan olarak girer', () => {
  const b = calculatePrice(excelVariant, excelCommission, excelSettings, { extraFarkPercent: 3 });
  const base = calculatePrice(excelVariant, excelCommission, excelSettings, { extraFarkPercent: 0 });
  assert.ok(b.salePrice.gt(base.salePrice));
});

// --------------------------------------------------- REVERSE_COMMISSION (V1.0)

test('SPEC: barem ustu, komisyon tersine hesaplanir', () => {
  const b = calculatePrice(
    { purchasePriceUsd: 10, customsTaxUsd: 1, freightCostUsd: 0.5, extraLossMargin: 2 },
    { commissionPercent: 16, extraCommissionPercent: 3.45 },
    specSettings,
  );
  assert.equal(b.costTry.toFixed(2), '391.00');
  assert.equal(b.targetRevenue.toFixed(2), '570.86');
  assert.equal(b.sellerPaysCargo, true);
  assert.equal(b.salePrice.toFixed(2), '783.19');
  assert.ok(b.payoutAmount.minus(b.targetRevenue).abs().lt(0.02));
});

test('SPEC: barem alti, kargo aliciya ait', () => {
  const b = calculatePrice(
    { purchasePriceUsd: 4, customsTaxUsd: 0, freightCostUsd: 0, extraLossMargin: 0 },
    { commissionPercent: 20, extraCommissionPercent: 0 },
    specSettings,
  );
  assert.equal(b.targetRevenue.toFixed(2), '195.84');
  assert.equal(b.sellerPaysCargo, false);
  assert.equal(b.salePrice.toFixed(2), '244.80');
});

test('SPEC: en yeniler ek kar payi kar yuzdesine eklenir', () => {
  const normal = calculatePrice(
    { purchasePriceUsd: 10, customsTaxUsd: 0, freightCostUsd: 0, extraLossMargin: 0 },
    { commissionPercent: 10, extraCommissionPercent: 0 },
    specSettings,
  );
  const yeni = calculatePrice(
    { purchasePriceUsd: 10, customsTaxUsd: 0, freightCostUsd: 0, extraLossMargin: 0, applyEnYeniler: true },
    { commissionPercent: 10, extraCommissionPercent: 0 },
    specSettings,
  );
  assert.equal(yeni.profitPercentApplied.toString(), '44.1');
  assert.ok(yeni.salePrice.gt(normal.salePrice));
});

test('SPEC: toplam komisyon %100 ise hata firlatir', () => {
  assert.throws(
    () =>
      calculatePrice(
        { purchasePriceUsd: 10, customsTaxUsd: 0, freightCostUsd: 0, extraLossMargin: 0 },
        { commissionPercent: 90, extraCommissionPercent: 10 },
        specSettings,
      ),
    PricingError,
  );
});

// ------------------------------------------------------------------ ortak

test('Kur sifir ise hata firlatir', () => {
  assert.throws(
    () => calculatePrice(excelVariant, excelCommission, { ...excelSettings, usdExchangeRate: 0 }, {}),
    PricingError,
  );
});

test('Psikolojik yuvarlama x.99 uretir', () => {
  const b = calculatePrice(excelVariant, excelCommission, {
    ...excelSettings,
    priceRoundingStrategy: 'PSYCHOLOGICAL_99',
  });
  assert.ok(b.salePrice.toFixed(2).endsWith('.99'));
});

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log(`  OK   ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${t.name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test basarili`);
process.exit(failed === 0 ? 0 : 1);
