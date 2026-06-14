// src/utils/helpers.ts

// Robustly parse currency/numeric strings that may contain symbols or commas
export const parseCurrencyToNumber = (value: string | number | undefined | null): number => {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  
  // Remove currency symbols, commas, and other non-numeric chars except decimal point and minus
  const sanitized = value.toString().replace(/[^0-9.-]/g, '');
  const num = parseFloat(sanitized);
  return isNaN(num) ? 0 : num;
};