import { useMemo, useState, useEffect } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { entryTypeLabel } from '../types/gemini';

// ── Column catalog (frontend mirror of the export RECEIPT_FIELDS) ──────────

export interface ReceiptTableColumn {
  key: string;          // field on the receipt row
  label: string;        // header text
  sortBy?: string | null; // backend allowlisted sort key (null = not sortable)
  default?: boolean;    // part of the default 8-column set
  align?: 'left' | 'right';
}

export const RECEIPT_TABLE_COLUMNS: ReceiptTableColumn[] = [
  { key: 'receiptDate', label: 'Date', sortBy: 'receipt_date', default: true },
  { key: 'supplier', label: 'Supplier', sortBy: 'supplier', default: true },
  { key: 'totalAmount', label: 'Total', sortBy: 'total_amount', default: true, align: 'right' },
  { key: 'taxAmount', label: 'Tax', sortBy: 'tax_amount', default: true, align: 'right' },
  { key: 'category', label: 'Category', sortBy: 'category', default: true },
  { key: 'status', label: 'Status', sortBy: 'status', default: true },
  { key: 'batchTitle', label: 'Batch', sortBy: 'batch_title', default: true },
  { key: 'invoiceNumber', label: 'Invoice #', sortBy: 'invoice_number', default: true },
  { key: 'entryType', label: 'Type', sortBy: 'entry_type', default: false },
  { key: 'location', label: 'Location', sortBy: 'location', default: false },
  { key: 'itemCount', label: 'Items', sortBy: null, default: false, align: 'right' },
  { key: 'kraPin', label: 'Seller PIN', sortBy: 'kra_pin', default: false },
  { key: 'buyerKraPin', label: 'Buyer PIN', sortBy: 'buyer_kra_pin', default: false },
  { key: 'cuInvoice', label: 'CU Invoice', sortBy: 'cu_invoice', default: false },
  { key: 'fileType', label: 'PDF', sortBy: 'file_type', default: false },
];

export const RECEIPT_TABLE_DEFAULT_COLUMNS = RECEIPT_TABLE_COLUMNS
  .filter(c => c.default)
  .map(c => c.key);

const STORAGE_PREFIX = 'scanapp-receipt-table-cols-';

function loadColumns(userId: string | null): string[] {
  if (!userId) return RECEIPT_TABLE_DEFAULT_COLUMNS;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return RECEIPT_TABLE_DEFAULT_COLUMNS;
    const parsed = JSON.parse(raw) as string[];
    if (!Array.isArray(parsed) || parsed.length === 0) return RECEIPT_TABLE_DEFAULT_COLUMNS;
    return parsed;
  } catch {
    return RECEIPT_TABLE_DEFAULT_COLUMNS;
  }
}

export function isBlankCellValue(v: any): boolean {
  return v === undefined || v === null || String(v).trim() === '' || String(v).trim().toUpperCase() === 'N/A';
}
function getRaw(receipt: any, key: string): any {
  if (receipt[key] !== undefined && receipt[key] !== null) return receipt[key];
  const snake = key.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (receipt[snake] !== undefined && receipt[snake] !== null) return receipt[snake];
  const camel = key.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase());
  if (receipt[camel] !== undefined && receipt[camel] !== null) return receipt[camel];
  return undefined;
}
export function cellValue(receipt: any, key: string): string {
  switch (key) {
    case 'itemCount':
      return String((receipt.items as any[] | undefined)?.length ?? receipt.itemCount ?? '');
    case 'fileType': {
      const ft = getRaw(receipt, 'fileType') as string | undefined;
      return ft === 'application/pdf'
        ? `PDF${receipt.pdfPageCount ?? receipt.pdf_page_count ? ` · ${receipt.pdfPageCount ?? receipt.pdf_page_count}p` : ''}`
        : '';
    }
    case 'entryType': {
      const raw = getRaw(receipt, 'entryType') as string | undefined;
      return entryTypeLabel(raw || 'expense');
    }
    case 'taxAmount':
      return String(getRaw(receipt, 'taxAmount') ?? '');
    case 'totalAmount':
      return String(getRaw(receipt, 'totalAmount') ?? '');
    case 'receiptDate':
      return String(getRaw(receipt, 'receiptDate') ?? '');
    default: {
      const raw = getRaw(receipt, key);
      return raw === undefined || raw === null ? '' : String(raw);
    }
  }
}

const PAGE_SIZES = [25, 50, 100, 200];

/**
 * Shared text/table view for receipt listings (no images).
 *
 * Data flow stays with the host page: it passes rows/total and fetch callbacks
 * (sort changes trigger its own server round-trip). The component owns the
 * table shell, sortable headers, column picker, pagination and export button.
 */
export default function ReceiptsTableView({
  userId,
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  pageSizeOptions = PAGE_SIZES,
  sortBy,
  sortOrder,
  onSortChange,
  loading,
  onRowClick,
  onExport,
  exporting = false,
  emptyText = 'No receipts found',
  topRight,
  columnFilters,
  onColumnFilter,
}: {
  userId: string | null;
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number, pageSize: number) => void;
  pageSizeOptions?: number[];
  sortBy?: string | null;
  sortOrder: 'asc' | 'desc';
  onSortChange: (sortBy: string | null, order: 'asc' | 'desc') => void;
  loading: boolean;
  onRowClick?: (receipt: any) => void;
  onExport?: () => void;
  exporting?: boolean;
  emptyText?: string;
  topRight?: React.ReactNode;
  columnFilters?: Record<string, string>;
  onColumnFilter?: (key: string, value: string) => void;
}) {
  const [columns, setColumns] = useState<string[]>(() => loadColumns(userId));
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!userId) return;
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(columns));
    } catch { /* storage full/blocked — ignore */ }
  }, [columns, userId]);

  const columnDefs = useMemo(
    () => RECEIPT_TABLE_COLUMNS.filter(c => columns.includes(c.key)),
    [columns],
  );

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const safePage = Math.min(page, totalPages);

  const toggleColumn = (key: string) => {
    setColumns(prev => prev.includes(key) ? prev.filter(c => c !== key) : [...prev, key]);
  };

  const headerClick = (col: ReceiptTableColumn) => {
    if (!col.sortBy) return;
    if (sortBy === col.sortBy) {
      onSortChange(col.sortBy, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      onSortChange(col.sortBy, 'asc');
    }
  };

  return (
    <div className="space-y-3">
      {/* Toolbar: column picker + export (+ host-provided extras) */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              onClick={() => setPickerOpen(o => !o)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              <Columns3 className="h-4 w-4" />
              Columns <span className="text-gray-400">({columns.length})</span>
            </button>
            {pickerOpen && (
              <div className="absolute z-30 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg p-2 max-h-80 overflow-y-auto">
                {RECEIPT_TABLE_COLUMNS.map(col => (
                  <label key={col.key} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-gray-50 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={columns.includes(col.key)}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
                <button
                  onClick={() => setColumns(RECEIPT_TABLE_DEFAULT_COLUMNS)}
                  className="mt-2 w-full px-2 py-1.5 text-xs text-blue-600 hover:bg-blue-50 rounded"
                >
                  Reset to default columns
                </button>
              </div>
            )}
          </div>

          {onExport && (
            <button
              onClick={onExport}
              disabled={exporting || rows.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {exporting ? 'Exporting…' : 'Export'}
            </button>
          )}
        </div>
        {topRight}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              {columnDefs.map(col => (
                <th
                  key={col.key}
                  className={`px-3 py-2.5 text-xs font-semibold text-gray-600 whitespace-nowrap ${
                    col.align === 'right' ? 'text-right' : 'text-left'
                  } ${col.sortBy ? 'cursor-pointer select-none hover:text-blue-600' : ''}`}
                  onClick={() => headerClick(col)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.label}
                    {col.sortBy ? (
                      sortBy === col.sortBy ? (
                        sortOrder === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" />
                      )
                    ) : null}
                  </span>
                </th>
              ))}
            </tr>
            {onColumnFilter && (
              <tr className="border-b border-gray-200 bg-white">
                {columnDefs.map(col => {
                  const isBlank = columnFilters?.[col.key] === '__BLANK__';
                  return (
                    <th key={col.key} className="px-1 py-1">
                      {col.key === 'itemCount' ? null : isBlank ? (
                        <button
                          onClick={() => onColumnFilter(col.key, '')}
                          className="w-full px-1 py-0.5 text-[10px] leading-tight bg-blue-100 text-blue-700 border border-blue-300 rounded hover:bg-blue-200 flex items-center justify-center gap-1"
                          title="Clear blanks filter"
                        >
                          blanks ×
                        </button>
                      ) : (
                        <div className="flex gap-1">
                          <input
                            type="text"
                            placeholder={`Filter ${col.label}`}
                            value={columnFilters?.[col.key] || ''}
                            onChange={e => onColumnFilter(col.key, e.target.value)}
                            className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <button
                            onClick={() => onColumnFilter(col.key, '__BLANK__')}
                            title={`Show only blank ${col.label}`}
                            className="px-1.5 py-1 text-[11px] font-medium border border-gray-300 rounded bg-white hover:bg-gray-50 text-gray-500 flex-shrink-0"
                          >
                            ∅
                          </button>
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            )}
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columnDefs.length || 1} className="px-3 py-10 text-center text-gray-400">
                  <div className="inline-block animate-spin rounded-full h-6 w-6 border-2 border-blue-500 border-t-transparent" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columnDefs.length || 1} className="px-3 py-10 text-center text-gray-400 text-sm">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr
                  key={r.id ?? i}
                  onClick={() => onRowClick?.(r)}
                  className={`border-b border-gray-100 ${onRowClick ? 'cursor-pointer hover:bg-blue-50/40' : ''}`}
                >
                  {columnDefs.map(col => {
                    const v = cellValue(r, col.key);
                    const isPdf = col.key === 'fileType' && v;
                    return (
                      <td
                        key={col.key}
                        className={`px-3 py-2 text-gray-700 whitespace-nowrap ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
                      >
                        {isPdf ? (
                          <span className="inline-flex rounded bg-red-500 text-white text-[10px] font-semibold px-1.5 py-0.5">
                            {v}
                          </span>
                        ) : (
                          v || <span className="text-gray-300">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="text-gray-500">
          {total.toLocaleString()} row{total !== 1 ? 's' : ''} · Page {safePage} of {totalPages}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={e => onPageChange(1, Number(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded-lg text-sm bg-white"
            aria-label="Rows per page"
          >
            {pageSizeOptions.map(s => (
              <option key={s} value={s}>{s} / page</option>
            ))}
          </select>
          <button
            onClick={() => onPageChange(safePage - 1, pageSize)}
            disabled={safePage <= 1}
            className="p-1.5 rounded-lg border hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="font-medium min-w-[3ch] text-center">{safePage}</span>
          <button
            onClick={() => onPageChange(safePage + 1, pageSize)}
            disabled={safePage >= totalPages}
            className="p-1.5 rounded-lg border hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}