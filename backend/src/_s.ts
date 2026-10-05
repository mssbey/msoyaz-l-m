import { prisma } from './lib/prisma.js';
const v = await prisma.productVariant.findFirst({ where: { variantCode: { startsWith: '676OK' }, purchasePriceUsd: { gt: 0 } }, select: { variantCode: true } });
console.log(v?.variantCode ?? '');
await prisma.$disconnect();
