import { RECEIPT_TABLE_COLUMNS } from '../components/ReceiptsTableView';

function csvEscape(v: string): string {
  const s = String(v ?? '');
  if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function cellForExport(receipt: any, key: string): string {
  switch (key) {
    case 'itemCount': return String(receipt.items?.length ?? '');
    case 'fileType': return receipt.fileType === 'application/pdf' ? 'pdf' : '';
    case 'taxAmount': return receipt.taxAmount ?? '';
    case 'totalAmount': return receipt.totalAmount ?? '';
    case 'receiptDate': return receipt.receiptDate ?? receipt.receipt_date ?? '';
    default: return receipt[key] ?? receipt[key.replace(/([A-Z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? '';
  }
}
export function visibleColumnKeys(userId: string | null): string[] {
  if (!userId) return RECEIPT_TABLE_COLUMNS.filter(c => c.default).map(c => c.key);
  try {
    const raw = localStorage.getItem(`scanapp-receipt-table-cols-${userId}`);
    if (!raw) return RECEIPT_TABLE_COLUMNS.filter(c => c.default).map(c => c.key);
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed) || parsed.length === 0) return RECEIPT_TABLE_COLUMNS.filter(c => c.default).map(c => c.key);
    return parsed;
  } catch { return RECEIPT_TABLE_COLUMNS.filter(c => c.default).map(c => c.key); }
}
export function exportRowsAsCsv(rows: any[], columnKeys: string[], filename: string) {
  const cols = RECEIPT_TABLE_COLUMNS.filter(c => columnKeys.includes(c.key));
  const header = cols.map(c => csvEscape(c.label)).join(',');
  const lines = rows.map(r => cols.map(c => csvEscape(cellForExport(r, c.key))).join(','));
  const csv = [header, ...lines].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function defaultExportName(prefix = 'receipts', filters?: { dateStart?: string; dateEnd?: string; batch?: string }, count?: number): string {
  const parts = [prefix];
  if (filters?.batch) parts.push(filters.batch.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20));
  if (filters?.dateStart || filters?.dateEnd) parts.push(`${filters.dateStart || 'start'}_to_${filters.dateEnd || 'now'}`);
  if (count !== undefined) parts.push(`${count}rows`);
  parts.push(new Date().toISOString().slice(0, 10));
  return parts.join('_') + '.csv';
}
