import { Marketplace, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Bos veritabani icin demo verisi (ayarlar + komisyonlar + ornek urunler).
 *
 * Gercek veri "npm run import" ile Excel'den gelir; bu yuzden veritabaninda
 * varyant varsa seed hicbir seye dokunmaz.
 */

const commissions: {
  marketplace: Marketplace;
  categoryId: string;
  commissionPercent: string;
  extraCommissionPercent: string;
}[] = [
  { marketplace: Marketplace.N11, categoryId: '*', commissionPercent: '16', extraCommissionPercent: '3.45' },
  { marketplace: Marketplace.HB, categoryId: '*', commissionPercent: '15.5', extraCommissionPercent: '3.45' },
  { marketplace: Marketplace.TY, categoryId: '*', commissionPercent: '18', extraCommissionPercent: '3.45' },
  { marketplace: Marketplace.PZRM, categoryId: '*', commissionPercent: '14', extraCommissionPercent: '3.45' },
  { marketplace: Marketplace.STD, categoryId: '*', commissionPercent: '0', extraCommissionPercent: '0' },
];

const products = [
  {
    mainProductCode: '676OK0022',
    name: 'Ornek Urun - Okul Cantasi',
    brand: 'MSO',
    category: 'CANTA',
    description: 'Excel aktarimi oncesi ornek kayit.',
    variants: [
      {
        variantCode: '676OK0022M1',
        barcode: '8680000000011',
        sentosStockCode: '676OK0022M1',
        color: 'Siyah',
        size: 'M',
        purchasePriceUsd: '10.00',
        customsTaxUsd: '1.00',
        freightCostUsd: '0.50',
        extraLossMargin: '2',
        stockQuantity: 25,
      },
      {
        variantCode: '676OK0022M2',
        barcode: '8680000000028',
        sentosStockCode: '676OK0022M2',
        color: 'Lacivert',
        size: 'M',
        purchasePriceUsd: '10.00',
        customsTaxUsd: '1.00',
        freightCostUsd: '0.50',
        extraLossMargin: '2',
        stockQuantity: 12,
        applyEnYeniler: true,
      },
    ],
  },
  {
    mainProductCode: '676OK0031',
    name: 'Ornek Urun - Beslenme Cantasi',
    brand: 'MSO',
    category: 'CANTA',
    variants: [
      {
        variantCode: '676OK0031S1',
        barcode: '8680000000035',
        sentosStockCode: '676OK0031S1',
        color: 'Kirmizi',
        size: 'S',
        purchasePriceUsd: '3.80',
        customsTaxUsd: '0.20',
        freightCostUsd: '0.15',
        extraLossMargin: '3',
        stockQuantity: 60,
      },
    ],
  },
];

async function main() {
  const existingVariants = await prisma.productVariant.count();
  if (existingVariants > 0) {
    console.log(`Veritabaninda ${existingVariants} varyant var; seed atlandi (Excel verisi korunuyor).`);
    return;
  }

  await prisma.setting.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      usdExchangeRate: '44.0000',
      targetProfitMarginPercent: '200',
      packagingCost: '25',
      cargoBaremLimit: '300',
      upperBaremCargoCost: '100',
      lowerBaremCargoCost: '85',
      standardCargoCost: '60',
      enYenilerExtraMargin: '10',
      enYenilerDiscountPercent: '0',
      priceRoundingStrategy: 'NONE',
      exchangeRateSource: 'SEED',
      exchangeRateUpdatedAt: new Date(),
    },
    update: {},
  });

  const marketplaceSettings = [
    { marketplace: Marketplace.STD, cargoBaremLimit: '300', extraFarkPercent: '0', marketPriceMarkupPercent: '0' },
    { marketplace: Marketplace.N11, cargoBaremLimit: '300', extraFarkPercent: '0', marketPriceMarkupPercent: '0' },
    { marketplace: Marketplace.HB, cargoBaremLimit: '300', extraFarkPercent: '0', marketPriceMarkupPercent: '0' },
    { marketplace: Marketplace.TY, cargoBaremLimit: '300', extraFarkPercent: '0', marketPriceMarkupPercent: '5' },
    { marketplace: Marketplace.PZRM, cargoBaremLimit: '300', extraFarkPercent: '0', marketPriceMarkupPercent: '5' },
  ];

  for (const setting of marketplaceSettings) {
    await prisma.marketplaceSetting.upsert({
      where: { marketplace: setting.marketplace },
      create: setting,
      update: setting,
    });
  }

  await prisma.marketplaceSetting.upsert({
    where: { marketplace: Marketplace.ENY },
    create: { marketplace: Marketplace.ENY, usesCargo: false, usesCommission: false },
    update: { usesCargo: false, usesCommission: false },
  });

  for (const commission of commissions) {
    await prisma.marketplaceCommission.upsert({
      where: {
        marketplace_categoryId: { marketplace: commission.marketplace, categoryId: commission.categoryId },
      },
      create: commission,
      update: commission,
    });
  }

  for (const product of products) {
    const { variants, ...productData } = product;
    const saved = await prisma.product.upsert({
      where: { mainProductCode: product.mainProductCode },
      create: productData,
      update: productData,
    });

    for (const variant of variants) {
      await prisma.productVariant.upsert({
        where: { variantCode: variant.variantCode },
        create: { ...variant, productId: saved.id },
        update: { ...variant, productId: saved.id },
      });
    }
  }

  const counts = {
    settings: await prisma.setting.count(),
    commissions: await prisma.marketplaceCommission.count(),
    marketplaceSettings: await prisma.marketplaceSetting.count(),
    products: await prisma.product.count(),
    variants: await prisma.productVariant.count(),
  };

  console.log('Seed tamamlandi:', counts);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
