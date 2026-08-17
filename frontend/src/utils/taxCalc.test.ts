/**
 * Unit tests for the pure tax math used by ReceiptForm bulk and per-item
 * add/split actions (utils/taxCalc.ts).
 */
import { describe, expect, it } from 'vitest';
import { addTax, splitTax } from './taxCalc';

describe('addTax', () => {
  it('adds tax on a tax-exclusive price', () => {
    expect(addTax(100, 16)).toBe(16);
    expect(addTax(1000, 16)).toBe(160);
  });

  it('handles fractional and zero rates', () => {
    expect(addTax(200, 7.5)).toBe(15);
    expect(addTax(250, 0)).toBe(0);
    expect(addTax(0, 16)).toBe(0);
  });

  it('rounds to 3 decimal places', () => {
    expect(addTax(100.55, 16)).toBe(16.088);
    expect(addTax(100.005, 16)).toBe(16.001);
  });
});

describe('splitTax', () => {
  it('extracts tax from a tax-inclusive price', () => {
    const r = splitTax(116, 16);
    expect(r.priceWithoutTax).toBeCloseTo(100, 10);
    expect(r.tax).toBeCloseTo(16, 10);
    expect(r.priceWithoutTax + r.tax).toBeCloseTo(116, 10);
  });

  it('keeps rounded base + tax equal to the inclusive price', () => {
    const r = splitTax(1000, 16);
    expect(r.priceWithoutTax).toBe(862.069);
    expect(r.tax).toBe(137.931);
    expect(r.priceWithoutTax + r.tax).toBe(1000);
  });

  it('handles fractional and zero rates', () => {
    const r = splitTax(215, 7.5);
    expect(r.priceWithoutTax).toBeCloseTo(200, 10);
    expect(r.tax).toBeCloseTo(15, 10);

    const zero = splitTax(99.5, 0);
    expect(zero.priceWithoutTax).toBe(99.5);
    expect(zero.tax).toBe(0);
  });

  it('handles zero price', () => {
    const r = splitTax(0, 16);
    expect(r.priceWithoutTax).toBe(0);
    expect(r.tax).toBe(0);
  });
});