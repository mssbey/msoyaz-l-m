import assert from 'node:assert/strict';
import { formatSentosDate, normalizeOrder, parseSentosDate, toMoney } from './orders.mapper.js';

/**
 * Sentos siparis donusum testleri (ornek govde API v1.5 dokumanindan).
 * Calistirma: npm run test:orders
 */

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const sample = {
  id: 1,
  order_id: 181849999,
  order_code: 203129724888,
  package_code: '',
  status: 5,
  source: 'N11',
  shop: 'Test Magaza',
  order_date: '2026-01-28 13:48:00',
  total: '29.9',
  shipping_total: 0,
  cargo_provider: 'Sentos Kargo',
  cargo_number: 968001002817777,
  has_invoice: 'yes',
  invoice_number: 'OM42025000001758',
  created_at: '2026-01-28 13:38:44',
  customer: { id: 1, name: 'Leland Calwell', phone: '0(556) 111 11 11', mail_address: 'email@gmail.com' },
  tracking_info: { cargo_company: 'Sentos Kargo', tracking_number: 'TR1234567', tracking_link: 'https://sentos.com.tr/TR1234567' },
  shipment_address: { id: 1, name: 'Leland Calwell', city: 'Konya', district: 'Selcuklu', address: 'Bosna Hersek Mh.' },
  lines: [
    {
      id: 0,
      sku: null,
      barcode: '8691123469069',
      orderlineid: 27541,
      status: 'accepted',
      name: 'Esofman Takimi',
      quantity: 1,
      list_price: '33.9',
      price: '29.9',
      discount: '4.00',
      amount: '29.9',
      vat_rate: 10,
      color: 'Kirmizi',
      model: { name: 'Beden', value: '3 Yas' },
      images: { id: 1370, url: 'https://test.sentos.com.tr/urunres/example.jpg' },
    },
  ],
};

test('parseSentosDate: Turkiye saatini UTC\'ye cevirir', () => {
  assert.equal(parseSentosDate('2026-01-28 13:48:00')?.toISOString(), '2026-01-28T10:48:00.000Z');
  assert.equal(parseSentosDate('2026-01-02 15:00')?.toISOString(), '2026-01-02T12:00:00.000Z');
  assert.equal(parseSentosDate(''), null);
  assert.equal(parseSentosDate('gecersiz'), null);
});

test('formatSentosDate: parseSentosDate ile tersinir', () => {
  const text = formatSentosDate(new Date('2026-01-28T10:48:00.000Z'));
  assert.equal(text, '2026-01-28 13:48:00');
  assert.equal(parseSentosDate(text)?.toISOString(), '2026-01-28T10:48:00.000Z');
});

test('toMoney: virgul, sayi ve bos degerler', () => {
  assert.equal(toMoney('29,90'), '29.90');
  assert.equal(toMoney(29.9), '29.90');
  assert.equal(toMoney(null), '0');
  assert.equal(toMoney('abc'), '0');
});

test('normalizeOrder: dokuman ornegini eksiksiz esler', () => {
  const order = normalizeOrder(sample as never);
  assert.equal(order.sentosId, 1);
  assert.equal(order.platformOrderId, '181849999');
  assert.equal(order.orderCode, '203129724888');
  assert.equal(order.packageCode, null);
  assert.equal(order.status, 5);
  assert.equal(order.source, 'N11');
  assert.equal(order.total, '29.90');
  assert.equal(order.shippingTotal, '0.00');
  assert.equal(order.customerName, 'Leland Calwell');
  assert.equal(order.city, 'Konya');
  assert.equal(order.cargoNumber, 'TR1234567');
  assert.equal(order.hasInvoice, true);
  assert.equal(order.orderDate?.toISOString(), '2026-01-28T10:48:00.000Z');
});

test('normalizeOrder: satir alanlari ve tek nesne gorsel', () => {
  const [line] = normalizeOrder(sample as never).lines;
  assert.deepEqual(line, {
    sentosLineId: '27541',
    sku: null,
    barcode: '8691123469069',
    name: 'Esofman Takimi',
    color: 'Kirmizi',
    size: '3 Yas',
    lineStatus: 'accepted',
    quantity: 1,
    listPrice: '33.90',
    price: '29.90',
    discount: '4.00',
    amount: '29.90',
    vatRate: 10,
    imageUrl: 'https://test.sentos.com.tr/urunres/example.jpg',
  });
});

test('normalizeOrder: satirsiz / eksik alanli siparis patlamaz', () => {
  const order = normalizeOrder({ id: 7, status: '1' } as never);
  assert.equal(order.status, 1);
  assert.deepEqual(order.lines, []);
  assert.equal(order.customerName, null);
});

console.log(`\n${passed} test gecti.`);
