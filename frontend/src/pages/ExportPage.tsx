import { useEffect, useMemo, useState } from 'react';
import { receiptApi, exportApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import { exportReport, exportMultiSheetExcel, defaultPivotConfig, type ReportType, type ExportFormat, type PivotConfig } from '../services/export';
import { FileSpreadsheet, FileText, FileDown, BarChart3, TrendingUp, Building2, Receipt, Percent, Loader2, AlertCircle, Table2, Server, Download } from 'lucide-react';

interface ExportPageProps {
  userId: string | null;
  customReceipts?: any[];
  onClose?: () => void;
}

const REPORT_TYPES: { value: ReportType; label: string; icon: any; desc: string }[] = [
  { value: 'detailed', label: 'Detailed Report', icon: Receipt, desc: 'Per-receipt breakdown with line items' },
  { value: 'category', label: 'By Category', icon: BarChart3, desc: 'Spending grouped by category' },
  { value: 'supplier', label: 'By Supplier', icon: Building2, desc: 'Spending grouped by supplier' },
  { value: 'monthly', label: 'Monthly Trend', icon: TrendingUp, desc: 'Spending per month, split by year' },
  { value: 'tax', label: 'Tax Summary', icon: Percent, desc: 'Zero-rated vs taxable breakdown' },
  { value: 'pivot', label: 'Pivot Table', icon: Table2, desc: 'Cross-tabulate month × supplier × category' },
];

const PIVOT_FIELDS = [
  { value: 'month' as const, label: 'Month (per year)' },
  { value: 'supplier' as const, label: 'Supplier' },
  { value: 'category' as const, label: 'Category' },
];

const PIVOT_VALUES = [
  { value: 'totalAmount' as const, label: 'Total Amount' },
  { value: 'count' as const, label: 'Receipt Count' },
];

const FORMATS: { value: ExportFormat; label: string; icon: any }[] = [
  { value: 'xlsx', label: 'Excel (.xlsx)', icon: FileSpreadsheet },
  { value: 'pdf', label: 'PDF (.pdf)', icon: FileText },
  { value: 'csv', label: 'CSV (.csv)', icon: FileDown },
];

const ExportPage = ({ userId, customReceipts, onClose }: ExportPageProps) => {
  const { items: cachedReceipts, loading: storeLoading, load } = useReceiptStore();
  const [reportType, setReportType] = useState<ReportType>('detailed');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [summary, setSummary] = useState<any>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [pivotConfig, setPivotConfig] = useState<PivotConfig>(defaultPivotConfig());
  const [backendLoading, setBackendLoading] = useState(false);
  const [exportMode, setExportMode] = useState<'client' | 'server'>('server');

  useEffect(() => {
    if (!customReceipts && userId) load(userId);
  }, [userId, customReceipts, load]);

  const receipts = useMemo(() => {
    const source = customReceipts ?? cachedReceipts;
    if (!dateRange.start && !dateRange.end) return source;
    const start = dateRange.start ? new Date(dateRange.start + 'T00:00:00') : null;
    const end = dateRange.end ? new Date(dateRange.end + 'T23:59:59') : null;
    return source.filter((r: any) => {
      const d = new Date(r.receiptDate);
      if (isNaN(d.getTime())) return !start && !end;
      return (!start || d >= start) && (!end || d <= end);
    });
  }, [customReceipts, cachedReceipts, dateRange]);

  const totalSpent = useMemo(
    () => receipts.reduce((s: number, r: any) => s + (parseFloat(r.totalAmount) || 0), 0),
    [receipts],
  );

  const handleExport = async () => {
    if (receipts.length === 0) return;
    const title = `receipts_${reportType}_${new Date().toISOString().slice(0, 10)}`;

    if (exportMode === 'server') {
      setBackendLoading(true);
      try {
        await exportApi.downloadReport({
          format,
          reportType,
          date_from: dateRange.start || undefined,
          date_to: dateRange.end || undefined,
          pivotConfig: reportType === 'pivot' ? {
            rowField: pivotConfig.rowField,
            colField: pivotConfig.colField,
            valueField: pivotConfig.valueField,
          } : undefined,
        });
      } catch (error: any) {
        alert(error.message || 'Server export failed');
      } finally {
        setBackendLoading(false);
      }
      return;
    }

    const opts = { title, dateRange, pivotConfig: reportType === 'pivot' ? pivotConfig : undefined };
    if (format === 'xlsx' && reportType === 'detailed') {
      exportMultiSheetExcel(receipts, opts);
    } else {
      exportReport(receipts, reportType, format, opts);
    }
  };

  const handleGenerateSummary = async () => {
    if (!userId || receipts.length === 0) return;
    setSummaryLoading(true);
    try {
      const result = await receiptApi.generateSummary({
        date_from: dateRange.start || undefined,
        date_to: dateRange.end || undefined,
      });
      setSummary(result);
    } catch (error) {
      console.error('Summary generation failed:', error);
    } finally {
      setSummaryLoading(false);
    }
  };

  const activeIcon = REPORT_TYPES.find(t => t.value === reportType)?.icon;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {activeIcon && <activeIcon className="h-7 w-7 text-blue-600" />}
          <h1 className="text-2xl font-bold text-gray-900">Export & Reports</h1>
        </div>
        {onClose && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-500">
            <FileDown className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left: Configuration ── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Date range */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Date Range</h2>
            <div className="flex gap-3 flex-wrap">
              <div>
                <label className="block text-xs text-gray-500 mb-1">From</label>
                <input type="date" value={dateRange.start} onChange={e => setDateRange(d => ({ ...d, start: e.target.value }))}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">To</label>
                <input type="date" value={dateRange.end} onChange={e => setDateRange(d => ({ ...d, end: e.target.value }))}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              {(dateRange.start || dateRange.end) && (
                <button onClick={() => setDateRange({ start: '', end: '' })}
                  className="self-end px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Report type */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Report Type</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {REPORT_TYPES.map(t => {
                const Icon = t.icon;
                const active = reportType === t.value;
                return (
                  <button key={t.value} onClick={() => setReportType(t.value)}
                    className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-all ${
                      active ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-200' : 'border-gray-200 hover:bg-gray-50'
                    }`}>
                    <Icon className={`h-5 w-5 mt-0.5 ${active ? 'text-blue-600' : 'text-gray-400'}`} />
                    <div>
                      <p className={`text-sm font-semibold ${active ? 'text-blue-700' : 'text-gray-800'}`}>{t.label}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{t.desc}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Pivot config */}
          {reportType === 'pivot' && (
            <div className="bg-white rounded-xl border border-blue-200 p-5">
              <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <Table2 className="h-4 w-4 text-blue-500" />
                Pivot Configuration
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Rows</label>
                  <select value={pivotConfig.rowField} onChange={e => setPivotConfig(p => ({ ...p, rowField: e.target.value as any }))}
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                    {PIVOT_FIELDS.map(f => <option key={f.value} value={f.value} disabled={f.value === pivotConfig.colField}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Columns</label>
                  <select value={pivotConfig.colField} onChange={e => setPivotConfig(p => ({ ...p, colField: e.target.value as any }))}
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                    {PIVOT_FIELDS.map(f => <option key={f.value} value={f.value} disabled={f.value === pivotConfig.rowField}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Values</label>
                  <select value={pivotConfig.valueField} onChange={e => setPivotConfig(p => ({ ...p, valueField: e.target.value as any }))}
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
                    {PIVOT_VALUES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-3 flex items-center gap-1">
                <Table2 className="h-3 w-3" />
                When month is used, data is split by year — each year gets its own sheet/page
              </p>
            </div>
          )}

          {/* Format */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex justify-between items-start mb-3">
              <h2 className="font-semibold text-gray-800">Export Format</h2>
              {/* Server / Client toggle */}
              <div className="flex items-center gap-2 text-xs">
                <span className={`${exportMode === 'server' ? 'text-purple-700 font-medium' : 'text-gray-400'}`}>Server</span>
                <button
                  type="button"
                  onClick={() => setExportMode(m => m === 'server' ? 'client' : 'server')}
                  className={`relative w-9 h-5 rounded-full transition-colors ${exportMode === 'server' ? 'bg-purple-600' : 'bg-gray-300'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${exportMode === 'server' ? 'left-4' : 'left-0.5'}`} />
                </button>
                <span className={`${exportMode === 'client' ? 'text-blue-700 font-medium' : 'text-gray-400'}`}>Browser</span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              {FORMATS.map(f => {
                const Icon = f.icon;
                const active = format === f.value;
                return (
                  <button key={f.value} onClick={() => setFormat(f.value)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                      active ? 'border-blue-500 bg-blue-50 text-blue-700 ring-1 ring-blue-200' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}>
                    <Icon className="h-4 w-4" />
                    {f.label}
                  </button>
                );
              })}
            </div>
            {exportMode === 'server' && (
              <p className="text-xs text-purple-600 mt-2 flex items-center gap-1">
                <Server className="h-3 w-3" />
                Generated server-side — styled with colored headers and formatting
              </p>
            )}
            {exportMode === 'client' && format === 'xlsx' && reportType === 'detailed' && (
              <p className="text-xs text-gray-500 mt-2 flex items-center gap-1">
                <FileSpreadsheet className="h-3 w-3" />
                Multi-sheet workbook with Detailed, Category, Supplier, Monthly & Tax reports
              </p>
            )}
          </div>

          {/* Preview */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Preview</h2>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">
                <span className="font-semibold text-gray-800">{receipts.length}</span> receipts · 
                <span className="font-semibold text-gray-800 ml-1">{totalSpent.toLocaleString()}</span> total
              </span>
              <span className="text-gray-400">{reportType === 'pivot' ? `Pivot: ${pivotConfig.rowField} × ${pivotConfig.colField}` : reportTitle(reportType)} → .{format}</span>
            </div>
          </div>

          {/* Export button */}
          <button onClick={handleExport} disabled={receipts.length === 0 || backendLoading}
            className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-semibold transition-colors shadow-sm ${
              backendLoading ? 'bg-purple-400 cursor-not-allowed' : exportMode === 'server' ? 'bg-purple-600 hover:bg-purple-700' : 'bg-blue-600 hover:bg-blue-700'
            } text-white disabled:bg-gray-300 disabled:text-gray-500`}>
            {backendLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileDown className="h-5 w-5" />}
            {backendLoading ? 'Generating…' : `Export ${reportType === 'pivot' ? `Pivot (${pivotConfig.rowField} × ${pivotConfig.colField})` : reportTitle(reportType)} as .${format.toUpperCase()}`}
          </button>
        </div>

        {/* ── Right: Summary & AI ── */}
        <div className="space-y-6">
          {/* Quick stats */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-800 mb-3">Quick Stats</h2>
            <div className="space-y-3">
              <div className="flex justify-between text-sm"><span className="text-gray-500">Total Spent</span><span className="font-bold text-gray-800">{totalSpent.toLocaleString()}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Receipts</span><span className="font-bold text-gray-800">{receipts.length}</span></div>
              <div className="flex justify-between text-sm"><span className="text-gray-500">Avg per Receipt</span><span className="font-bold text-gray-800">{receipts.length > 0 ? (totalSpent / receipts.length).toFixed(2) : '0'}</span></div>
            </div>
          </div>

          {/* AI Summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="font-semibold text-gray-800 mb-3">AI Spending Summary</h2>
            <button onClick={handleGenerateSummary} disabled={summaryLoading || receipts.length === 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500 to-blue-500 text-white rounded-lg text-sm font-medium hover:from-purple-600 hover:to-blue-600 disabled:from-gray-300 disabled:to-gray-300 disabled:text-gray-500 transition-all">
              {summaryLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
              {summaryLoading ? 'Analyzing…' : summary ? 'Refresh Analysis' : 'Generate AI Summary'}
            </button>

            {summary && (
              <div className="mt-4 space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-blue-50 rounded-lg p-2.5 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">Total</p>
                    <p className="font-bold text-blue-700">{summary.total_spent.toLocaleString()}</p>
                  </div>
                  <div className="bg-green-50 rounded-lg p-2.5 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">Avg/Receipt</p>
                    <p className="font-bold text-green-700">{summary.avg_per_receipt.toLocaleString()}</p>
                  </div>
                </div>

                {summary.category_breakdown?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-600 mb-1.5">By Category</p>
                    <div className="space-y-1">
                      {summary.category_breakdown.slice(0, 5).map((c: any) => (
                        <div key={c.category} className="flex items-center gap-2">
                          <span className="text-xs text-gray-600 w-24 truncate">{c.category}</span>
                          <div className="flex-1 bg-gray-100 rounded-full h-2">
                            <div className="bg-blue-500 rounded-full h-2" style={{ width: `${Math.min(c.percentage, 100)}%` }} />
                          </div>
                          <span className="text-xs font-medium text-gray-700 w-16 text-right">{c.percentage}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {summary.top_suppliers?.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-600 mb-1">Top Suppliers</p>
                    <div className="space-y-1">
                      {summary.top_suppliers.slice(0, 5).map((s: any) => (
                        <div key={s.supplier} className="flex justify-between text-xs">
                          <span className="text-gray-600 truncate">{s.supplier}</span>
                          <span className="font-medium text-gray-800">{s.total.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {summary.ai_summary && (
                  <div className="bg-gray-50 rounded-lg p-3 border text-xs text-gray-700 whitespace-pre-line leading-relaxed">
                    {summary.ai_summary}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

function reportTitle(type: ReportType): string {
  const titles: Record<ReportType, string> = {
    detailed: 'Detailed Receipt Report',
    category: 'Spending by Category',
    supplier: 'Spending by Supplier',
    monthly: 'Monthly Spending Trend',
    tax: 'Tax Summary Report',
  };
  return titles[type];
}

export default ExportPage;
