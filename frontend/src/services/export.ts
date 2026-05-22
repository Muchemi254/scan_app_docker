import { utils, writeFile, type WorkBook, type WorkSheet } from 'xlsx';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

type ReportType = 'detailed' | 'category' | 'supplier' | 'monthly' | 'tax' | 'pivot';
type ExportFormat = 'xlsx' | 'pdf' | 'csv';

export interface PivotConfig {
  rowField: 'month' | 'supplier' | 'category';
  colField: 'month' | 'supplier' | 'category';
  valueField: 'totalAmount' | 'count';
}

export function defaultPivotConfig(): PivotConfig {
  return { rowField: 'month', colField: 'category', valueField: 'totalAmount' };
}

const NUMERIC_FIELDS = new Set(['Quantity', 'Price', 'Tax', 'Total', 'totalAmount', 'taxAmount']);
const DATE_FIELDS = new Set(['receiptDate']);

function sanitizeNumeric(v: any): number {
  const n = typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : Number(v);
  return isNaN(n) ? 0 : n;
}

function sanitize(val: any, key: string): any {
  if (DATE_FIELDS.has(key)) return val ? String(val) : '';
  if (NUMERIC_FIELDS.has(key)) return sanitizeNumeric(val);
  return val ?? '';
}

function parseDateMDY(dateStr: string): Date | null {
  if (!dateStr) return null;
  const parts = String(dateStr).split('/');
  if (parts.length === 3) {
    const m = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    const y = parseInt(parts[2], 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000) {
      return new Date(y, m - 1, d);
    }
  }
  return null;
}

function cleanRows(rows: any[]): any[] {
  return rows.map(row => {
    const cleaned: any = {};
    for (const key in row) cleaned[key] = sanitize(row[key], key);
    return cleaned;
  });
}

export interface ReportOptions {
  title: string;
  dateRange?: { start: string; end: string };
  pivotConfig?: PivotConfig;
}

// ─── Aggregation helpers ─────────────────────────────────────────────────

interface FlatItem {
  receiptId: string;
  receiptDate: string;
  supplier: string;
  totalAmount: number;
  category: string;
  invoiceNumber: string;
  status: string;
  itemName: string;
  quantity: number;
  price: number;
  tax: number;
  discount: number;
  isZeroRated: boolean;
  itemTotal: number;
}

function flattenToItems(receipts: any[]): FlatItem[] {
  const result: FlatItem[] = [];
  for (const r of receipts) {
    const base = {
      receiptId: r.id || '',
      receiptDate: r.receiptDate || '',
      supplier: r.supplier || '',
      totalAmount: sanitizeNumeric(r.totalAmount),
      category: r.category || 'Other',
      invoiceNumber: r.invoiceNumber || '',
      status: r.status || '',
    };
    const items = r.items || [];
    if (items.length > 0) {
      for (const item of items) {
        const qty = sanitizeNumeric(item.quantity) || 1;
        const price = sanitizeNumeric(item.price);
        const tax = sanitizeNumeric(item.tax);
        const discount = sanitizeNumeric(item.discount);
        const subtotal = qty * (price + tax);
        const discountFactor = discount ? (1 - discount / 100) : 1;
        result.push({
          ...base,
          itemName: item.name || '',
          quantity: qty,
          price,
          tax,
          discount,
          isZeroRated: item.isZeroRated === true,
          itemTotal: Number((subtotal * discountFactor).toFixed(2)),
        });
      }
    } else {
      result.push({
        ...base,
        itemName: '',
        quantity: 0,
        price: 0,
        tax: 0,
        discount: 0,
        isZeroRated: false,
        itemTotal: 0,
      });
    }
  }
  return result;
}

// ─── Report data generators ──────────────────────────────────────────────

function detailedRows(receipts: any[]): any[] {
  return flattenToItems(receipts).map(i => ({
    'Receipt ID': i.receiptId,
    Date: parseDateMDY(i.receiptDate) || i.receiptDate,
    Supplier: i.supplier,
    Category: i.category,
    Invoice: i.invoiceNumber,
    Item: i.itemName,
    Qty: i.quantity,
    Price: i.price,
    Tax: i.tax,
    'Disc%': i.discount || '',
    'Zero Rated': i.isZeroRated ? 'Yes' : 'No',
    'Item Total': i.itemTotal,
    'Receipt Total': i.totalAmount,
    Status: i.status,
  }));
}

function categorySummary(receipts: any[]): any[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const r of receipts) {
    const cat = r.category || 'Other';
    const amt = sanitizeNumeric(r.totalAmount);
    const existing = map.get(cat) || { total: 0, count: 0 };
    existing.total += amt;
    existing.count += 1;
    map.set(cat, existing);
  }
  const grandTotal = [...map.values()].reduce((s, v) => s + v.total, 0);
  return [...map.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([cat, v]) => ({
      Category: cat,
      'Total Spent': Number(v.total.toFixed(2)),
      'Receipt Count': v.count,
      'Percentage': grandTotal > 0 ? Number(((v.total / grandTotal) * 100).toFixed(1)) : 0,
    }));
}

function supplierSummary(receipts: any[]): any[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const r of receipts) {
    const sup = r.supplier || 'Unknown';
    const amt = sanitizeNumeric(r.totalAmount);
    const existing = map.get(sup) || { total: 0, count: 0 };
    existing.total += amt;
    existing.count += 1;
    map.set(sup, existing);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([sup, v]) => ({
      Supplier: sup,
      'Total Spent': Number(v.total.toFixed(2)),
      'Receipt Count': v.count,
      'Avg per Receipt': Number((v.total / v.count).toFixed(2)),
    }));
}

function monthlyTrend(receipts: any[], _year?: string): any[] {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const map = new Map<string, { total: number; count: number }>();
  for (const r of receipts) {
    const d = r.receiptDate || '';
    if (d.length >= 7) {
      const mIdx = parseInt(d.slice(0, 2), 10) - 1;
      const mName = months[mIdx] || d.slice(0, 2);
      const amt = sanitizeNumeric(r.totalAmount);
      const existing = map.get(mName) || { total: 0, count: 0 };
      existing.total += amt;
      existing.count += 1;
      map.set(mName, existing);
    }
  }
  const order = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return order.filter(m => map.has(m)).map(m => ({
    Month: m,
    'Total Spent': Number((map.get(m)!.total).toFixed(2)),
    'Receipt Count': map.get(m)!.count,
    'Avg per Receipt': Number((map.get(m)!.total / map.get(m)!.count).toFixed(2)),
  }));
}

function taxSummary(receipts: any[]): any[] {
  const items = flattenToItems(receipts);
  let zeroRatedTotal = 0;
  let taxedTotal = 0;
  let zeroRatedCount = 0;
  let taxedCount = 0;
  for (const i of items) {
    if (i.isZeroRated) {
      zeroRatedTotal += i.itemTotal;
      zeroRatedCount += 1;
    } else {
      taxedTotal += i.itemTotal;
      taxedCount += 1;
    }
  }
  return [
    { Category: 'Zero Rated (Tax Exempt)', 'Total Amount': Number(zeroRatedTotal.toFixed(2)), 'Item Count': zeroRatedCount },
    { Category: 'Taxable', 'Total Amount': Number(taxedTotal.toFixed(2)), 'Item Count': taxedCount },
    { Category: 'Combined Total', 'Total Amount': Number((zeroRatedTotal + taxedTotal).toFixed(2)), 'Item Count': zeroRatedCount + taxedCount },
  ];
}

function reportTitle(type: ReportType, cfg?: PivotConfig): string {
  if (type === 'pivot' && cfg) {
    const v = pivotValueLabel(cfg);
    return `Pivot: ${cfg.rowField} × ${cfg.colField} (${v})`;
  }
  const titles: Record<ReportType, string> = {
    detailed: 'Detailed Receipt Report',
    category: 'Spending by Category',
    supplier: 'Spending by Supplier',
    monthly: 'Monthly Spending Trend',
    tax: 'Tax Summary Report',
    pivot: 'Pivot Table',
  };
  return titles[type];
}

function reportData(type: ReportType, receipts: any[], cfg?: PivotConfig): any[] {
  switch (type) {
    case 'detailed': return detailedRows(receipts);
    case 'category': return categorySummary(receipts);
    case 'supplier': return supplierSummary(receipts);
    case 'monthly': return monthlyTrend(receipts);
    case 'tax': return taxSummary(receipts);
    case 'pivot': {
      if (!cfg) return [];
      const pivot = computePivot(receipts, cfg);
      return pivotRows(pivot, cfg);
    }
  }
}

// ─── Pivot table ─────────────────────────────────────────────────────────

function fieldValue(r: any, field: string): string {
  if (field === 'month') {
    const d = r.receiptDate || '';
    if (d.length >= 7) {
      const month = d.slice(0, 2);
      const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return names[parseInt(month, 10) - 1] || month;
    }
    return 'Unknown';
  }
  if (field === 'supplier') return r.supplier || 'Unknown';
  if (field === 'category') return r.category || 'Other';
  return 'Unknown';
}

function extractYear(r: any): string {
  const d = r.receiptDate || '';
  return d.length >= 10 ? d.slice(6, 10) : '';
}

function yearsInData(receipts: any[]): string[] {
  const years = new Set<string>();
  for (const r of receipts) {
    const y = extractYear(r);
    if (y) years.add(y);
  }
  return [...years].sort();
}

function rowHasMonth(cfg: PivotConfig): boolean {
  return cfg.rowField === 'month' || cfg.colField === 'month';
}

export interface PivotTable {
  rowLabels: string[];
  colLabels: string[];
  grid: Record<string, Record<string, number>>;
  rowTotals: Record<string, number>;
  colTotals: Record<string, number>;
  grandTotal: number;
}

function computePivot(receipts: any[], cfg: PivotConfig): PivotTable {
  const grid: Record<string, Record<string, number>> = {};
  const rowLabelsSet = new Set<string>();
  const colLabelsSet = new Set<string>();
  const rowTotals: Record<string, number> = {};
  const colTotals: Record<string, number> = {};
  let grandTotal = 0;

  for (const r of receipts) {
    const rowVal = fieldValue(r, cfg.rowField);
    const colVal = fieldValue(r, cfg.colField);
    rowLabelsSet.add(rowVal);
    colLabelsSet.add(colVal);

    if (!grid[rowVal]) grid[rowVal] = {};
    const val = cfg.valueField === 'totalAmount' ? sanitizeNumeric(r.totalAmount) : 1;
    grid[rowVal][colVal] = (grid[rowVal][colVal] || 0) + val;
    rowTotals[rowVal] = (rowTotals[rowVal] || 0) + val;
    colTotals[colVal] = (colTotals[colVal] || 0) + val;
    grandTotal += val;
  }

  const rowLabels = [...rowLabelsSet].sort((a, b) => (rowTotals[b] || 0) - (rowTotals[a] || 0));
  const colLabels = [...colLabelsSet].sort((a, b) => (colTotals[b] || 0) - (colTotals[a] || 0));

  return { rowLabels, colLabels, grid, rowTotals, colTotals, grandTotal };
}

function pivotRows(pivot: PivotTable, cfg: PivotConfig): any[] {
  const rows: any[] = [];
  const rowHeader = cfg.rowField.charAt(0).toUpperCase() + cfg.rowField.slice(1);
  for (const r of pivot.rowLabels) {
    const row: any = { [rowHeader]: r };
    for (const c of pivot.colLabels) {
      row[c] = Number((pivot.grid[r]?.[c] || 0).toFixed(2));
    }
    row['Total'] = Number((pivot.rowTotals[r] || 0).toFixed(2));
    rows.push(row);
  }
  const footer: any = { [rowHeader]: 'Grand Total' };
  for (const c of pivot.colLabels) {
    footer[c] = Number((pivot.colTotals[c] || 0).toFixed(2));
  }
  footer['Total'] = Number(pivot.grandTotal.toFixed(2));
  rows.push(footer);
  return rows;
}

function pivotValueLabel(cfg: PivotConfig): string {
  return cfg.valueField === 'totalAmount' ? 'Total Amount' : 'Receipt Count';
}

function _sheet(wb: WorkBook, name: string, rows: any[]) {
  const ws = utils.json_to_sheet(rows);
  utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

function _groupByYear(receipts: any[]): Map<string, any[]> {
  const map = new Map<string, any[]>();
  for (const r of receipts) {
    const y = extractYear(r);
    if (!y) continue;
    if (!map.has(y)) map.set(y, []);
    map.get(y)!.push(r);
  }
  return map;
}

// ─── XLSX (multi-sheet) ──────────────────────────────────────────────────

export function exportMultiSheetExcel(receipts: any[], opts: ReportOptions) {
  const wb: WorkBook = utils.book_new();

  if (receipts.length === 0) {
    const ws = utils.json_to_sheet([{ Message: 'No receipt data to export.' }]);
    utils.book_append_sheet(wb, ws, 'Data');
    writeFile(wb, `${opts.title}.xlsx`);
    return;
  }

  // Static reports
  _sheet(wb, 'Detailed', cleanRows(detailedRows(receipts)));
  _sheet(wb, 'By Category', cleanRows(categorySummary(receipts)));
  _sheet(wb, 'By Supplier', cleanRows(supplierSummary(receipts)));

  // Monthly — one sheet per year
  for (const year of yearsInData(receipts)) {
    const yr = receipts.filter((r: any) => extractYear(r) === year);
    _sheet(wb, `Monthly ${year}`, cleanRows(monthlyTrend(yr)));
  }

  _sheet(wb, 'Tax Summary', cleanRows(taxSummary(receipts)));

  writeFile(wb, `${opts.title}.xlsx`);
}

// ─── Single-sheet XLSX ────────────────────────────────────────────────────

export function exportToExcel(receipts: any[], type: ReportType, opts: ReportOptions) {
  const wb: WorkBook = utils.book_new();
  const pc = opts.pivotConfig;

  if ((type === 'monthly') || (type === 'pivot' && pc && rowHasMonth(pc))) {
    for (const [year, yr] of _groupByYear(receipts)) {
      const rows = cleanRows(reportData(type, yr, pc));
      _sheet(wb, `${type === 'monthly' ? 'Monthly' : 'Pivot'} ${year}`, rows);
    }
  } else if (type === 'pivot') {
    _sheet(wb, 'Pivot', cleanRows(reportData(type, receipts, pc)));
  } else {
    _sheet(wb, reportTitle(type).slice(0, 31), cleanRows(reportData(type, receipts, pc)));
  }
  writeFile(wb, `${opts.title}.xlsx`);
}

// ─── CSV ──────────────────────────────────────────────────────────────────

export function exportToCSV(receipts: any[], type: ReportType, opts: ReportOptions) {
  const pc = opts.pivotConfig;
  let rows: any[];

  if (type === 'monthly') {
    // Include year column for monthly CSV
    rows = [];
    for (const [year, yr] of _groupByYear(receipts)) {
      for (const r of monthlyTrend(yr)) {
        rows.push({ Year: year, ...r });
      }
    }
  } else if (type === 'pivot' && pc && rowHasMonth(pc)) {
    rows = [];
    for (const [year, yr] of _groupByYear(receipts)) {
      const pivot = computePivot(yr, pc);
      for (const r of pivotRows(pivot, pc)) {
        rows.push({ Year: year, ...r });
      }
    }
  } else {
    rows = cleanRows(reportData(type, receipts, pc));
  }

  const ws = utils.json_to_sheet(rows);
  const csv = utils.sheet_to_csv(ws);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${opts.title}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Enhanced PDF ─────────────────────────────────────────────────────────

function _pdfTable(doc: any, headers: string[], body: any[][], startY: number) {
  (doc as any).lastAutoTable = undefined;
  autoTable(doc, {
    head: [headers],
    body,
    startY,
    styles: { fontSize: 7, cellWidth: 'wrap' },
    headStyles: { fillColor: [30, 64, 175], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    margin: { top: 40 },
    pageBreak: 'auto',
    didDrawPage: (data: any) => {
      doc.setFontSize(7);
      const pw = doc.internal.pageSize.getWidth();
      doc.text(`Page ${data.pageCount}`, pw - 20, doc.internal.pageSize.getHeight() - 10);
    },
  });
}

export function exportToPDF(receipts: any[], type: ReportType, opts: ReportOptions) {
  const doc = new jsPDF('landscape' as any, undefined, 'a4');
  const pc = opts.pivotConfig;

  // Title
  doc.setFontSize(18);
  doc.text(opts.title, 14, 18);
  doc.setFontSize(9);
  doc.text(`Generated: ${new Date().toLocaleString()} | ${receipts.length} receipts`, 14, 25);
  if (opts.dateRange?.start || opts.dateRange?.end) {
    const range = `${opts.dateRange.start || '…'} — ${opts.dateRange.end || '…'}`;
    doc.text(`Period: ${range}`, 14, 30);
  }

  const isMonthlyOrPivotMonth = type === 'monthly' || (type === 'pivot' && pc && rowHasMonth(pc));

  if (isMonthlyOrPivotMonth) {
    let yCursor = 38;
    for (const [year, yr] of _groupByYear(receipts)) {
      if (yCursor > 35) {
        doc.addPage();
        yCursor = 20;
      }
      doc.setFontSize(13);
      doc.text(`${year}`, 14, yCursor);
      yCursor += 6;

      const yearTotal = yr.reduce((s: number, r: any) => s + sanitizeNumeric(r.totalAmount), 0);
      doc.setFontSize(8);
      doc.text(`Total: ${yearTotal.toLocaleString()} | Receipts: ${yr.length}`, 14, yCursor);
      yCursor += 5;

      const data = reportData(type, yr, pc);
      if (data.length > 0) {
        const headers = Object.keys(data[0]);
        const body = data.map((r: any) => headers.map(h => typeof r[h] === 'number' ? (r[h] as number).toLocaleString() : String(r[h] ?? '')));
        _pdfTable(doc, headers, body, yCursor);
        yCursor = (doc as any).lastAutoTable?.finalY + 10 || yCursor + 50;
      }
    }
  } else {
    const data = reportData(type, receipts, pc);
    if (data.length === 0) {
      doc.setFontSize(12);
      doc.text('No data to display.', 14, 40);
    } else {
      const totalSpent = receipts.reduce((s, r) => s + sanitizeNumeric(r.totalAmount), 0);
      const summaryY = (opts.dateRange?.start || opts.dateRange?.end) ? 36 : 30;
      doc.setFontSize(10);
      doc.text(`Total Spent: ${totalSpent.toLocaleString()}`, 14, summaryY);
      doc.text(`Avg per Receipt: ${(totalSpent / (receipts.length || 1)).toFixed(2)}`, 80, summaryY);

      const headers = Object.keys(data[0]);
      const body = data.map((r: any) => headers.map(h => typeof r[h] === 'number' ? (r[h] as number).toLocaleString() : String(r[h] ?? '')));
      _pdfTable(doc, headers, body, summaryY + 6);
    }
  }

  doc.save(`${opts.title}.pdf`);
}

// ─── Multi-format export dispatcher ───────────────────────────────────────

export function exportReport(
  receipts: any[],
  type: ReportType,
  format: ExportFormat,
  opts: ReportOptions,
) {
  switch (format) {
    case 'xlsx':
      exportToExcel(receipts, type, opts);
      break;
    case 'pdf':
      exportToPDF(receipts, type, opts);
      break;
    case 'csv':
      exportToCSV(receipts, type, opts);
      break;
  }
}

export {
  computePivot,
  pivotRows,
  pivotValueLabel,
  fieldValue,
};

export type { ReportType, ExportFormat };
