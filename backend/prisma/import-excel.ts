/**
 * "Tam Liste" calisma kitabini sisteme aktarir.
 *
 * Kullanim:
 *   npm run import -- "C:/Users/PC/Desktop/Tam Liste-27.xlsx"
 *   npm run import -- <dosya> --dry-run          (sadece rapor, DB'ye yazmaz)
 *   npm run import -- <dosya> --no-verify        (dogrulama adimini atlar)
 *   npm run import -- <dosya> --deactivate-missing  (dosyada olmayan varyantlari pasife ceker)
 *
 * Aktarim sonrasi tum fiyatlar yeniden hesaplanir ve Excel'in kendi
 * sonuc kolonlariyla karsilastirilarak dogrulama raporu basilir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Marketplace, PricingModel, PrismaClient, type Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';

const prisma = new PrismaClient();

// --- Excel kolon indeksleri (0 tabanli) ---
const LISTE = {
  mainProductCode: 1, // B
  barcode: 3, // D
  variantCode: 5, // F
  purchaseUsd: 7, // H  Nakliye Dahil Alis ($)
  customsUsd: 9, // J  KDV Dahil Gumruk Vergisi ($)
  costUsd: 11, // L  Vergiler Dahil Maliyet ($)
  costTry: 13, // N  Vergiler Dahil Maliyet (TL)
  targetPrice: 15, // P  Paketleme Dahil Hedef Satis Fiyati
  extraIlave: 17, // R  % Extra ilave
  commission: 19, // T  Pazaryeri Komisyon Yuzdesi
  extraCommission: 21, // V  Pazaryeri Ek Komisyon Yuzdesi
  stdPrice: 23, // X
  stdPayout: 25, // Z
  n11Price: 27, // AB
  hbPrice: 31, // AF
  tyPrice: 35, // AJ
  tyMarketPrice: 39, // AN
  pzrmPrice: 41, // AP
  pzrmMarketPrice: 45, // AT
  enyPrice: 47, // AV
  stock: 49, // AX
  name: 51, // AZ
  brand: 53, // BB
  category: 55, // BD
  model: 57, // BF
  color: 59, // BH
  size: 61, // BJ
  description: 63, // BL
} as const;

const RESIMLER = { variantCode: 0, firstPhoto: 2, lastPhoto: 21 };

type Row = (string | number | boolean | null)[];

interface Args {
  file: string;
  dryRun: boolean;
  verify: boolean;
  deactivateMissing: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Kullanim: npm run import -- "<dosya yolu>.xlsx" [--dry-run] [--no-verify] [--deactivate-missing]');
    process.exit(1);
  }
  return {
    file: path.resolve(file),
    dryRun: argv.includes('--dry-run'),
    verify: !argv.includes('--no-verify'),
    deactivateMissing: argv.includes('--deactivate-missing'),
  };
}

function num(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

/** Oran -> yuzde (0.16 => 16), 6 hane hassasiyetle. */
function toPercent(value: unknown): string {
  return (num(value) * 100).toFixed(6);
}

function normalizeLabel(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[:$]/g, '')
    .replace(/1\.00/g, '')
    .trim()
    .toLocaleLowerCase('tr-TR');
}

/**
 * "MSO Ayarlar" sayfasi etiket/deger ciftlerinden olusur: etiketin hemen
 * altindaki hucre degerdir. Konum yerine etikete gore okunur.
 */
function readSettingsSheet(rows: Row[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let r = 0; r < rows.length - 1; r += 1) {
    const row = rows[r] ?? [];
    const next = rows[r + 1] ?? [];
    for (let c = 0; c < row.length; c += 1) {
      const label = row[c];
      const value = next[c];
      if (typeof label === 'string' && label.trim() && typeof value === 'number') {
        map.set(normalizeLabel(label), value);
      }
    }
  }
  return map;
}

function requireSetting(map: Map<string, number>, label: string): number {
  const key = normalizeLabel(label);
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`"MSO Ayarlar" sayfasinda "${label}" bulunamadi.`);
  }
  return value;
}

function optionalSetting(map: Map<string, number>, label: string, fallback = 0): number {
  return map.get(normalizeLabel(label)) ?? fallback;
}

async function main() {
  const args = parseArgs();
  console.log(`\nDosya: ${args.file}${args.dryRun ? '  (DRY RUN)' : ''}\n`);

  // ESM ortaminda XLSX.readFile kullanilamaz; dosya buffer olarak okunur.
  const workbook = XLSX.read(fs.readFileSync(args.file), { type: 'buffer', cellFormula: false, cellHTML: false });
  const sheet = (name: string): Row[] => {
    const ws = workbook.Sheets[name];
    if (!ws) throw new Error(`Calisma kitabinda "${name}" sayfasi yok.`);
    return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  };

  // ---------------------------------------------------------------- ayarlar
  const settingsMap = readSettingsSheet(sheet('MSO Ayarlar'));

  const profitMultiplier = requireSetting(settingsMap, 'Karlılık %');
  const exchangeRate = requireSetting(settingsMap, 'Döviz Kuru: $1.00');
  const stdBarem = requireSetting(settingsMap, 'Pazaryeri STD Kargo Baremi');
  const upperCargo = requireSetting(settingsMap, 'Üst Barem Kargo');
  const lowerCargo = requireSetting(settingsMap, 'Alt Barem Kargo');
  const packaging = requireSetting(settingsMap, 'Birim Paketleme Gideri');
  const enyFark = requireSetting(settingsMap, 'eNyeniler Extra Fark');
  const enyIndirim = optionalSetting(settingsMap, 'eNyeniler Extra İndirim', 0);

  const marketplaceParams: Record<string, { barem: number; fark: number; piyasa: number }> = {
    STD: { barem: stdBarem, fark: 0, piyasa: 0 },
    N11: {
      barem: optionalSetting(settingsMap, 'N11 Kargo Baremi', stdBarem),
      fark: optionalSetting(settingsMap, 'N11 Extra Fark', 0),
      piyasa: optionalSetting(settingsMap, 'N11 Piyasa Fiyatı', 0),
    },
    HB: {
      barem: optionalSetting(settingsMap, 'HB Kargo Baremi', stdBarem),
      fark: optionalSetting(settingsMap, 'HB Extra Fark', 0),
      piyasa: optionalSetting(settingsMap, 'HB Piyasa Fiyatı', 0),
    },
    TY: {
      barem: optionalSetting(settingsMap, 'TY Kargo Baremi', stdBarem),
      fark: optionalSetting(settingsMap, 'TY Extra Fark', 0),
      piyasa: optionalSetting(settingsMap, 'TY Piyasa Fiyatı', 0),
    },
    PZRM: {
      barem: optionalSetting(settingsMap, 'PZRM Kargo Baremi', stdBarem),
      fark: optionalSetting(settingsMap, 'PZRM Extra Fark', 0),
      piyasa: optionalSetting(settingsMap, 'PZRM Piyasa Fiyatı', 0),
    },
  };

  console.log('MSO Ayarlar:');
  console.log(`  Karlilik: x${profitMultiplier} (%${profitMultiplier * 100})   Kur: ${exchangeRate} TL`);
  console.log(`  Paketleme: ${packaging} TL   Ust barem kargo: ${upperCargo} TL   Alt barem kargo: ${lowerCargo} TL`);
  console.log(`  eNyeniler fark: %${enyFark * 100}   indirim: %${enyIndirim * 100}`);
  for (const [mp, p] of Object.entries(marketplaceParams)) {
    console.log(`  ${mp.padEnd(5)} barem: ${p.barem}   extra fark: %${p.fark * 100}   piyasa: %${p.piyasa * 100}`);
  }

  // ------------------------------------------------------------------ liste
  const listeRows = sheet('MSO Liste').slice(1);
  const dataRows = listeRows.filter((row) => str(row[LISTE.variantCode]));

  console.log(`\nMSO Liste: ${dataRows.length} varyant satiri okundu.`);

  // Resimler
  const photoByVariant = new Map<string, string[]>();
  try {
    for (const row of sheet('MSO Resimler').slice(1)) {
      const code = str(row[RESIMLER.variantCode]);
      if (!code) continue;
      const photos: string[] = [];
      for (let c = RESIMLER.firstPhoto; c <= RESIMLER.lastPhoto; c += 1) {
        const url = str(row[c]);
        if (url) photos.push(url);
      }
      if (photos.length) photoByVariant.set(code, photos);
    }
  } catch (err) {
    console.warn(`  Uyari: resim sayfasi okunamadi (${(err as Error).message})`);
  }
  console.log(`MSO Resimler: ${photoByVariant.size} varyant icin gorsel bulundu.`);

  // Tekillik kontrolu
  const seenVariant = new Set<string>();
  const seenBarcode = new Set<string>();
  const duplicates: string[] = [];
  const missingBarcode: string[] = [];

  for (const row of dataRows) {
    const code = str(row[LISTE.variantCode])!;
    const barcode = str(row[LISTE.barcode]);
    if (seenVariant.has(code)) duplicates.push(`varyant kodu tekrar: ${code}`);
    seenVariant.add(code);
    if (!barcode) {
      missingBarcode.push(code);
    } else if (seenBarcode.has(barcode)) {
      duplicates.push(`barkod tekrar: ${barcode}`);
    } else {
      seenBarcode.add(barcode);
    }
  }

  if (duplicates.length) {
    console.error('\nHATA: tekrar eden kayitlar var, aktarim durduruldu:');
    for (const d of duplicates.slice(0, 20)) console.error(`  - ${d}`);
    process.exit(1);
  }
  if (missingBarcode.length) {
    console.warn(`\nUyari: ${missingBarcode.length} varyantin barkodu bos, varyant kodu barkod olarak kullanilacak.`);
  }

  // Urun kirilimi (ana urun kodu bazinda)
  const products = new Map<string, { name: string; brand: string | null; category: string | null; description: string | null }>();
  for (const row of dataRows) {
    const code = str(row[LISTE.mainProductCode]) ?? str(row[LISTE.variantCode])!;
    if (!products.has(code)) {
      products.set(code, {
        name: str(row[LISTE.name]) ?? code,
        brand: str(row[LISTE.brand]),
        category: str(row[LISTE.category]),
        description: str(row[LISTE.description]),
      });
    }
  }
  console.log(`Ana urun sayisi: ${products.size}`);

  const totalStock = dataRows.reduce((sum, row) => sum + Math.trunc(num(row[LISTE.stock])), 0);
  console.log(`Toplam stok adedi: ${totalStock}`);

  if (args.dryRun) {
    console.log('\nDRY RUN: veritabanina yazilmadi.');
    await prisma.$disconnect();
    return;
  }

  // ------------------------------------------------------------- DB yazimi
  await prisma.setting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      pricingModel: PricingModel.EXCEL_MARKUP,
      usdExchangeRate: exchangeRate.toFixed(4),
      targetProfitMarginPercent: (profitMultiplier * 100).toFixed(3),
      packagingCost: packaging.toFixed(2),
      cargoBaremLimit: stdBarem.toFixed(2),
      upperBaremCargoCost: upperCargo.toFixed(2),
      lowerBaremCargoCost: lowerCargo.toFixed(2),
      enYenilerExtraMargin: (enyFark * 100).toFixed(3),
      enYenilerDiscountPercent: (enyIndirim * 100).toFixed(3),
      cargoTestBase: '1.019',
      enYenilerBase: '1.018',
      // Excel yuvarlama yapmaz; birebir ayni sonuc icin yuvarlama kapatilir.
      priceRoundingStrategy: 'NONE',
      exchangeRateSource: 'EXCEL_IMPORT',
      exchangeRateUpdatedAt: new Date(),
    },
    update: {
      pricingModel: PricingModel.EXCEL_MARKUP,
      usdExchangeRate: exchangeRate.toFixed(4),
      targetProfitMarginPercent: (profitMultiplier * 100).toFixed(3),
      packagingCost: packaging.toFixed(2),
      cargoBaremLimit: stdBarem.toFixed(2),
      upperBaremCargoCost: upperCargo.toFixed(2),
      lowerBaremCargoCost: lowerCargo.toFixed(2),
      enYenilerExtraMargin: (enyFark * 100).toFixed(3),
      enYenilerDiscountPercent: (enyIndirim * 100).toFixed(3),
      priceRoundingStrategy: 'NONE',
      exchangeRateSource: 'EXCEL_IMPORT',
      exchangeRateUpdatedAt: new Date(),
    },
  });

  for (const [mp, params] of Object.entries(marketplaceParams)) {
    const marketplace = mp as Marketplace;
    const values = {
      cargoBaremLimit: params.barem.toFixed(2),
      extraFarkPercent: (params.fark * 100).toFixed(3),
      marketPriceMarkupPercent: (params.piyasa * 100).toFixed(3),
      usesCargo: true,
      usesCommission: true,
      isActive: true,
    };
    await prisma.marketplaceSetting.upsert({
      where: { marketplace },
      create: { marketplace, ...values },
      update: values,
    });
  }

  // eNyeniler kendi formulunu kullanir: kargo ve komisyon uygulanmaz.
  await prisma.marketplaceSetting.upsert({
    where: { marketplace: Marketplace.ENY },
    create: {
      marketplace: Marketplace.ENY,
      cargoBaremLimit: '0',
      extraFarkPercent: '0',
      marketPriceMarkupPercent: '0',
      usesCargo: false,
      usesCommission: false,
      isActive: true,
    },
    update: { usesCargo: false, usesCommission: false, isActive: true },
  });

  // Varsayilan komisyon (varyantta deger yoksa kullanilir): dosyadaki en yaygin oran
  const commissionCounts = new Map<string, number>();
  for (const row of dataRows) {
    const key = `${toPercent(row[LISTE.commission])}|${toPercent(row[LISTE.extraCommission])}`;
    commissionCounts.set(key, (commissionCounts.get(key) ?? 0) + 1);
  }
  const [defaultCommissionKey] = [...commissionCounts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const [defaultCommission, defaultExtraCommission] = defaultCommissionKey.split('|') as [string, string];

  for (const mp of Object.keys(marketplaceParams)) {
    const marketplace = mp as Marketplace;
    const values = {
      commissionPercent: defaultCommission,
      extraCommissionPercent: defaultExtraCommission,
      isActive: true,
    };
    await prisma.marketplaceCommission.upsert({
      where: { marketplace_categoryId: { marketplace, categoryId: '*' } },
      create: { marketplace, categoryId: '*', ...values },
      update: values,
    });
  }

  console.log(`\nVarsayilan komisyon: %${defaultCommission} + %${defaultExtraCommission}`);

  // Urunler
  let productCount = 0;
  for (const [code, data] of products) {
    await prisma.product.upsert({
      where: { mainProductCode: code },
      create: { mainProductCode: code, ...data },
      update: data,
    });
    productCount += 1;
  }
  console.log(`Urunler yazildi: ${productCount}`);

  const productIds = new Map(
    (await prisma.product.findMany({ select: { id: true, mainProductCode: true } })).map((p) => [
      p.mainProductCode,
      p.id,
    ]),
  );

  // Varyantlar
  let variantCount = 0;
  const chunkSize = 50;
  for (let i = 0; i < dataRows.length; i += chunkSize) {
    const chunk = dataRows.slice(i, i + chunkSize);
    const operations: Prisma.PrismaPromise<unknown>[] = [];

    for (const row of chunk) {
      const variantCode = str(row[LISTE.variantCode])!;
      const mainCode = str(row[LISTE.mainProductCode]) ?? variantCode;
      const productId = productIds.get(mainCode);
      if (!productId) continue;

      const photos = photoByVariant.get(variantCode);
      const values = {
        productId,
        barcode: str(row[LISTE.barcode]) ?? variantCode,
        sentosStockCode: variantCode,
        color: str(row[LISTE.color]),
        size: str(row[LISTE.size]),
        model: str(row[LISTE.model]),
        purchasePriceUsd: num(row[LISTE.purchaseUsd]).toFixed(6),
        customsTaxUsd: num(row[LISTE.customsUsd]).toFixed(6),
        freightCostUsd: '0',
        extraLossMargin: toPercent(row[LISTE.extraIlave]),
        commissionPercent: toPercent(row[LISTE.commission]),
        extraCommissionPercent: toPercent(row[LISTE.extraCommission]),
        stockQuantity: Math.max(0, Math.trunc(num(row[LISTE.stock]))),
        imageUrl: photos?.[0] ?? null,
        isActive: true,
      };

      operations.push(
        prisma.productVariant.upsert({
          where: { variantCode },
          create: { variantCode, ...values },
          update: values,
        }),
      );
      variantCount += 1;
    }

    await prisma.$transaction(operations);
    process.stdout.write(`\r  Varyantlar: ${Math.min(i + chunkSize, dataRows.length)}/${dataRows.length}`);
  }
  console.log(`\nVaryantlar yazildi: ${variantCount}`);

  if (args.deactivateMissing) {
    const result = await prisma.productVariant.updateMany({
      where: { variantCode: { notIn: [...seenVariant] }, isActive: true },
      data: { isActive: false },
    });
    console.log(`Dosyada olmayan ${result.count} varyant pasife cekildi.`);
  } else {
    const missing = await prisma.productVariant.count({
      where: { variantCode: { notIn: [...seenVariant] }, isActive: true },
    });
    if (missing) {
      console.log(`Not: dosyada olmayan ${missing} aktif varyant var (--deactivate-missing ile pasife cekilebilir).`);
    }
  }

  // -------------------------------------------------------- fiyat hesaplama
  const { recalculateAll } = await import('../src/modules/pricing/pricing.service.js');
  const { invalidateSettingsCache } = await import('../src/modules/settings/settings.service.js');
  await invalidateSettingsCache();

  console.log('\nFiyatlar hesaplaniyor...');
  const recalc = await recalculateAll({ batchSize: 200 });
  console.log(`  ${recalc.processed} varyant islendi, ${recalc.changedCount} fiyat guncellendi.`);
  if (recalc.failures.length) {
    console.warn(`  ${recalc.failures.length} hesaplama hatasi:`);
    for (const f of recalc.failures.slice(0, 5)) console.warn(`   - ${f.variantCode} / ${f.marketplace}: ${f.error}`);
  }

  if (args.verify) await verify(dataRows);

  await cleanup();
}

/**
 * Fiyat servisi Redis/kuyruk baglantilarini da acar; script'in kapanabilmesi
 * icin hepsi kapatilir.
 */
async function cleanup() {
  await prisma.$disconnect();
  try {
    const { closeQueues } = await import('../src/queues/queues.js');
    await closeQueues();
    const { disconnectRedis } = await import('../src/lib/redis.js');
    await disconnectRedis();
  } catch {
    // Kuyruk modulu hic yuklenmediyse kapatilacak bir sey yoktur.
  }
}

/** Hesaplanan fiyatlari Excel'in kendi sonuc kolonlariyla karsilastirir. */
async function verify(dataRows: Row[]) {
  console.log('\nDogrulama: hesaplanan fiyatlar vs Excel kolonlari');

  const expectedByCode = new Map<string, Record<string, number>>();
  for (const row of dataRows) {
    const code = str(row[LISTE.variantCode]);
    if (!code) continue;
    expectedByCode.set(code, {
      STD: num(row[LISTE.stdPrice]),
      N11: num(row[LISTE.n11Price]),
      HB: num(row[LISTE.hbPrice]),
      TY: num(row[LISTE.tyPrice]),
      PZRM: num(row[LISTE.pzrmPrice]),
      ENY: num(row[LISTE.enyPrice]),
      TY_MARKET: num(row[LISTE.tyMarketPrice]),
      PZRM_MARKET: num(row[LISTE.pzrmMarketPrice]),
      TARGET: num(row[LISTE.targetPrice]),
      COST_TRY: num(row[LISTE.costTry]),
      PAYOUT_STD: num(row[LISTE.stdPayout]),
    });
  }

  const prices = await prisma.variantPrice.findMany({
    include: { variant: { select: { variantCode: true } } },
  });

  const maxDiff = new Map<string, { diff: number; code: string }>();
  const tolerance = 0.01;
  let compared = 0;
  const mismatches: string[] = [];

  const track = (key: string, code: string, actual: number, expected: number) => {
    compared += 1;
    const diff = Math.abs(actual - expected);
    const current = maxDiff.get(key);
    if (!current || diff > current.diff) maxDiff.set(key, { diff, code });
    if (diff > tolerance) {
      mismatches.push(`${code} / ${key}: hesaplanan ${actual.toFixed(6)} vs Excel ${expected.toFixed(6)}`);
    }
  };

  for (const price of prices) {
    const expected = expectedByCode.get(price.variant.variantCode);
    if (!expected) continue;

    track(price.marketplace, price.variant.variantCode, Number(price.salePrice), expected[price.marketplace] ?? 0);

    if (price.marketplace === Marketplace.TY && price.marketPrice) {
      track('TY_MARKET', price.variant.variantCode, Number(price.marketPrice), expected.TY_MARKET ?? 0);
    }
    if (price.marketplace === Marketplace.PZRM && price.marketPrice) {
      track('PZRM_MARKET', price.variant.variantCode, Number(price.marketPrice), expected.PZRM_MARKET ?? 0);
    }
    if (price.marketplace === Marketplace.STD) {
      track('TARGET', price.variant.variantCode, Number(price.targetRevenue), expected.TARGET ?? 0);
      track('COST_TRY', price.variant.variantCode, Number(price.costTry), expected.COST_TRY ?? 0);
      track('PAYOUT_STD', price.variant.variantCode, Number(price.payoutAmount), expected.PAYOUT_STD ?? 0);
    }
  }

  console.log(`  Karsilastirilan deger: ${compared}`);
  for (const [key, value] of [...maxDiff.entries()].sort()) {
    console.log(`  ${key.padEnd(12)} maks fark: ${value.diff.toExponential(3)}  (${value.code})`);
  }

  if (mismatches.length) {
    console.error(`\n  ${mismatches.length} deger ${tolerance} toleransini asti:`);
    for (const m of mismatches.slice(0, 15)) console.error(`   - ${m}`);
    process.exitCode = 1;
  } else {
    console.log('\n  Tum fiyatlar Excel ile birebir ortusuyor.');
  }
}

main().catch(async (err) => {
  console.error('\nAktarim hatasi:', err);
  await prisma.$disconnect();
  process.exit(1);
});
