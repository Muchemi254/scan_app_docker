// Shared per-item money math so every item list (edit + view) anchors on the
// same semantics: line total = qty * (price + tax) * discountFactor.
import { parseCurrencyToNumber } from './helpers';

export interface ItemTotals {
  tax: number;
  total: number;
}

const discountFactor = (discount: string | number | undefined | null): number => {
  const pct = parseCurrencyToNumber(discount);
  return pct > 0 ? 1 - pct / 100 : 1;
};

/** Tax portion of a single line, discount-adjusted. */
export const lineTaxOf = (item: { quantity: any; tax: any; discount?: any }): number => {
  const qty = Number(item.quantity) || 0;
  const tax = parseCurrencyToNumber(item.tax);
  return qty * tax * discountFactor(item.discount);
};

/** Grand total of a single line, discount-adjusted. */
export const lineTotalOf = (item: { quantity: any; price: any; tax: any; discount?: any }): number => {
  const qty = Number(item.quantity) || 0;
  const price = parseCurrencyToNumber(item.price);
  const tax = parseCurrencyToNumber(item.tax);
  return qty * (price + tax) * discountFactor(item.discount);
};

/** Summed totals over a whole item list. */
export const sumItemTotals = (items: any[]): ItemTotals =>
  items.reduce(
    (acc: ItemTotals, item: any) => {
      acc.tax += lineTaxOf(item);
      acc.total += lineTotalOf(item);
      return acc;
    },
    { tax: 0, total: 0 },
  );
