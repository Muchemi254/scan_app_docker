// Pure tax math shared by ReceiptForm bulk and per-item add/split actions.
import Decimal from 'decimal.js';

/** Add tax to a tax-exclusive price: tax = price * rate / 100 (3 dp). */
export const addTax = (price: number, rate: number): number =>
  new Decimal(price).mul(rate).div(100).toDecimalPlaces(3).toNumber();

/**
 * Split tax out of a tax-inclusive price.
 * tax is derived from the unrounded base first, then both are rounded to 3 dp
 * so priceWithoutTax + tax tracks the original inclusive price closely.
 */
export const splitTax = (price: number, rate: number): { priceWithoutTax: number; tax: number } => {
  const full = new Decimal(price);
  const base = full.div(new Decimal(1).plus(rate / 100));
  const tax = full.minus(base);
  return {
    priceWithoutTax: base.toDecimalPlaces(3).toNumber(),
    tax: tax.toDecimalPlaces(3).toNumber(),
  };
};