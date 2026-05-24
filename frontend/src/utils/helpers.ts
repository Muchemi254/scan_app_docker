// src/utils/helpers.ts
// Convert file to Base64 string
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]); // Remove data:image/... prefix
    };
    reader.onerror = error => reject(error);
  });
};

// Check if receipt data is missing critical fields
export const isMissingCriticalFields = (data: any): boolean => {
  return !data?.supplier || data.supplier === 'N/A' || data.supplier === 'Unknown' ||
         !data?.totalAmount || data.totalAmount === 'N/A' || data.totalAmount === 'Unknown' ||
         !data?.receiptDate || data.receiptDate === 'N/A' || data.receiptDate === 'Unknown' ||
         !data?.category || data.category === 'N/A' || data.category === 'Unknown';
};

// Robustly parse currency/numeric strings that may contain symbols or commas
export const parseCurrencyToNumber = (value: string | number | undefined | null): number => {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  
  // Remove currency symbols, commas, and other non-numeric chars except decimal point and minus
  const sanitized = value.toString().replace(/[^0-9.-]/g, '');
  const num = parseFloat(sanitized);
  return isNaN(num) ? 0 : num;
};

// Generate a unique key for a receipt to prevent duplicates
export const generateReceiptKey = (data: any): string => {
  const supplier = (data.supplier || 'N/A').trim().toLowerCase();
  const total = parseCurrencyToNumber(data.totalAmount).toString();
  const date = (data.receiptDate || 'N/A').trim();
  const items = (data.items || [])
    .map((i: any) => (i.name || '').trim().toLowerCase())
    .sort()
    .join('|');

  return `${supplier}-${total}-${date}-${items}`;
};

// Format currency values consistently
export const formatCurrency = (value: string | number): string => {
  const num = parseCurrencyToNumber(value);
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES'
  }).format(isNaN(num) ? 0 : num);
};