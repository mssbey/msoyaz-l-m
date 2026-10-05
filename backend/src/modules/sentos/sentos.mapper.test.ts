import assert from 'node:assert/strict';
import { applyStockDelta, normalizeStocks, toSentosStocks, totalStock } from './sentos.mapper.js';

/**
 * Sentos stok dagitim testleri.
 * Calistirma: npm run test:sentos
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('normalizeStocks: sayi ve nesne depo bicimlerini okur', () => {
  const stocks = normalizeStocks([
    { warehouse: 1, stock: 18 },
    { warehouse: { id: 7, name: 'TRENDALIN' }, stock: '4' },
  ]);
  assert.deepEqual(stocks, [
    { warehouseId: 1, stock: 18 },
    { warehouseId: 7, stock: 4 },
  ]);
  assert.equal(totalStock(stocks), 22);
});

test('dusus once tercih edilen depodan yapilir', () => {
  const { stocks, applied } = applyStockDelta(
    [
      { warehouseId: 1, stock: 10 },
      { warehouseId: 7, stock: 5 },
    ],
    -3,
    7,
  );
  assert.equal(applied, -3);
  assert.deepEqual(stocks, [
    { warehouseId: 1, stock: 10 },
    { warehouseId: 7, stock: 2 },
  ]);
});

test('tercih edilen depo yetmezse en dolu depodan tamamlanir', () => {
  const { stocks, applied } = applyStockDelta(
    [
      { warehouseId: 1, stock: 1 },
      { warehouseId: 3, stock: 2 },
      { warehouseId: 7, stock: 6 },
    ],
    -4,
    1,
  );
  assert.equal(applied, -4);
  assert.deepEqual(toSentosStocks(stocks), [
    { warehouse: 1, stock: 0 },
    { warehouse: 3, stock: 2 },
    { warehouse: 7, stock: 3 },
  ]);
});

test('toplam stok sifirin altina inmez', () => {
  const { stocks, applied } = applyStockDelta([{ warehouseId: 1, stock: 2 }], -5, null);
  assert.equal(applied, -2);
  assert.equal(totalStock(stocks), 0);
});

test('artis tercih edilen depoya eklenir, depo yoksa olusturulur', () => {
  const { stocks } = applyStockDelta([{ warehouseId: 1, stock: 2 }], 3, 9);
  assert.deepEqual(stocks, [
    { warehouseId: 9, stock: 3 },
    { warehouseId: 1, stock: 2 },
  ]);
});

console.log(`\n${passed} test gecti.`);
