import Decimal from 'decimal.js';

// Para hesaplarinda kayan nokta hatasi olmamasi icin tum islemler Decimal uzerinde yapilir.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export type Numeric = Decimal | number | string | { toString(): string };

export function d(value: Numeric | null | undefined): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  if (typeof value === 'number' || typeof value === 'string') return new Decimal(value);
  return new Decimal(value.toString());
}

export type RoundingStrategy = 'NONE' | 'ROUND_2' | 'PSYCHOLOGICAL_99';

/** Satis fiyatina uygulanacak son yuvarlama. */
export function applyRounding(value: Decimal, strategy: RoundingStrategy): Decimal {
  switch (strategy) {
    case 'NONE':
      return value;
    case 'PSYCHOLOGICAL_99': {
      // 249.13 -> 249.99 ; 250.00 -> 250.99 (asagi yuvarlanip kar kaybedilmez)
      const floored = value.floor();
      return floored.plus('0.99');
    }
    case 'ROUND_2':
    default:
      return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
}

/** Prisma Decimal alanlarina yazmak icin string donusumu (hassasiyet kaybi olmaz). */
export function toDb(value: Decimal, places = 4): string {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

export function toNumber(value: Numeric | null | undefined): number {
  return d(value).toNumber();
}

export { Decimal };
