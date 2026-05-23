import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { backupApi, type BackupEntry, type BackupPreview, type ImportResult } from '../services/backupApi';
import {
  Download, Upload, Trash2, RefreshCw, FileArchive,
  CheckCircle, AlertCircle, Clock, Database, Image as ImageIcon, Shield,
  ChevronDown, ChevronRight, X, Sparkles, FileSpreadsheet,
} from 'lucide-react';
import AiScanningEnginePage from './AiScanningEnginePage';

// Keep export page import for its report logic
import { receiptApi, exportApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import { exportReport, exportMultiSheetExcel, defaultPivotConfig, type ReportType, type ExportFormat, type PivotConfig } from '../services/export';
import { FileText, BarChart3, TrendingUp, Building2, Receipt, Percent, Table2 } from 'lucide-react';

type Tab = 'ai' | 'export' | 'backup';

const CONFLICT_MODES = [
  { value: 'skip', label: 'Skip existing', desc: 'Import only new receipts, keep current data' },
  { value: 'overwrite', label: 'Overwrite all', desc: 'Replace all existing receipts with backup data' },
  { value: 'merge', label: 'Merge (update only)', desc: 'Update existing receipts, add new ones' },
] as const;

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

const SettingsPage = ({ userId }: { userId: string | null }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Tab | null;
  const [activeTab, setActiveTab] = useState<Tab>(tabParam || 'ai');

  // Sync URL param on tab change
  useEffect(() => {
    if (activeTab !== 'ai') setSearchParams({ tab: activeTab });
    else setSearchParams({});
  }, [activeTab]);

  // ── Backup state ──
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ pct: 0, status: '' });
  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [conflictMode, setConflictMode] = useState<string>('skip');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importStep, setImportStep] = useState<string>('');
  const [error, setError] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  // ── Export state ──
  const { items: storeReceipts, load: loadStore } = useReceiptStore();
  const [reportType, setReportType] = useState<ReportType>('detailed');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('xlsx');
  const [pivotConfig, setPivotConfig] = useState<PivotConfig>(defaultPivotConfig);
  const [exportLoading, setExportLoading] = useState(false);
  const [multiSheet, setMultiSheet] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => { if (userId) loadStore(userId); }, [userId, loadStore]);

  const handleBackendExport = async () => {
    try {
      setExportLoading(true);
      const filters: any = { format: exportFormat, reportType };
      if (dateFrom) filters.date_from = dateFrom;
      if (dateTo) filters.date_to = dateTo;
      if (reportType === 'pivot') {
        filters.pivotConfig = {
          rowField: pivotConfig.rowField,
          colField: pivotConfig.colField,
          valueField: pivotConfig.valueField,
        };
      }
      await exportApi.downloadReport({
        format: exportFormat,
        reportType,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        pivotConfig: reportType === 'pivot' ? {
          rowField: pivotConfig.rowField,
          colField: pivotConfig.colField,
          valueField: pivotConfig.valueField,
        } : undefined,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally { setExportLoading(false); }
  };

  const handleFrontendExport = () => {
    if (multiSheet) {
      exportMultiSheetExcel(storeReceipts);
    } else {
      exportReport(storeReceipts, reportType, exportFormat, pivotConfig, dateFrom, dateTo);
    }
  };

  const loadBackups = useCallback(async () => {
    try { setLoadingBackups(true); setError(''); const list = await backupApi.listBackups(); setBackups(list); }
    catch (e) { setError(e instanceof Error ? e.message : 'Failed to load backups'); }
    finally { setLoadingBackups(false); }
  }, []);

  useEffect(() => { if (userId) loadBackups(); }, [userId, loadBackups]);

  const handleExport = async () => {
    try { setExporting(true); setError(''); setExportProgress({pct:0,status:'Starting...'});
      await backupApi.exportBackup((pct, status) => setExportProgress({pct, status})); await loadBackups(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); }
    finally { setExporting(false); }
  };

  const handleFileSelect = async (file: File) => {
    setImportFile(file); setImportResult(null); setSelectedIds(new Set()); setImportStep('previewing');
    try { setPreviewing(true); const p = await backupApi.previewBackup(file); setPreview(p); setError(''); setImportStep(''); }
    catch (e) { setPreview(null); setImportStep(''); setError(e instanceof Error ? e.message : 'Preview failed'); }
    finally { setPreviewing(false); }
  };

  const handleImport = async () => {
    if (!importFile) return;
    try { setImporting(true); setImportStep('importing');
      const ids = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
      const result = await backupApi.importBackup(importFile, conflictMode, ids);
      setImportResult(result); setImportStep('done'); setError(''); }
    catch (e) { setImportStep(''); setError(e instanceof Error ? e.message : 'Import failed'); }
    finally { setImporting(false); }
  };

  const handleDeleteBackup = async (backupId: string) => {
    if (!confirm('Delete this backup?')) return;
    try { await backupApi.deleteBackup(backupId); await loadBackups(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  };

  const toggleReceipt = (id: string) => setSelectedIds(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const toggleAll = () => {
    if (!preview) return;
    if (selectedIds.size === preview.receipt_count) setSelectedIds(new Set());
    else setSelectedIds(new Set(preview.receipts.map(r => r.id)));
  };

  if (!userId) return null;

  const tabs = [
    { key: 'ai', label: 'AI Engine', icon: Sparkles },
    { key: 'export', label: 'Export', icon: FileSpreadsheet },
    { key: 'backup', label: 'Backup & Restore', icon: Shield },
  ] as const;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {tabs.map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <tab.icon className="h-4 w-4" />{tab.label}
          </button>
        ))}
      </div>

      {/* ── AI Engine Tab ── */}
      {activeTab === 'ai' && <AiScanningEnginePage userId={userId} />}

      {/* ── Export Tab ── */}
      {activeTab === 'export' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-green-600" /> Export Receipts
            </h2>

            {/* Report type */}
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Report Type</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-2">
                {REPORT_TYPES.map(rt => {
                  const Icon = rt.icon;
                  return (
                    <button key={rt.value} onClick={() => setReportType(rt.value)}
                      className={`flex items-center gap-2 p-3 rounded-lg border text-left text-sm transition-colors ${
                        reportType === rt.value ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 hover:bg-gray-50'
                      }`}>
                      <Icon className="h-4 w-4 flex-shrink-0" />
                      <div>
                        <div className="font-medium">{rt.label}</div>
                        <div className="text-xs text-gray-400">{rt.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Format */}
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Format</label>
              <div className="flex gap-2 mt-2">
                {(['xlsx', 'pdf', 'csv'] as ExportFormat[]).map(f => (
                  <button key={f} onClick={() => setExportFormat(f)}
                    className={`px-4 py-1.5 rounded text-sm font-medium border ${
                      exportFormat === f ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}>{f.toUpperCase()}</button>
                ))}
              </div>
            </div>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Date From (MM/DD/YYYY)</label>
                <input type="text" value={dateFrom} onChange={e => setDateFrom(e.target.value)} placeholder="01/01/2025"
                  className="w-full px-2 py-1.5 border rounded text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Date To</label>
                <input type="text" value={dateTo} onChange={e => setDateTo(e.target.value)} placeholder="12/31/2025"
                  className="w-full px-2 py-1.5 border rounded text-sm" />
              </div>
            </div>

            {/* Pivot config */}
            {reportType === 'pivot' && (
              <div className="grid grid-cols-3 gap-3 bg-gray-50 rounded-lg p-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Rows</label>
                  <select value={pivotConfig.rowField} onChange={e => setPivotConfig({...pivotConfig, rowField: e.target.value as any})}
                    className="w-full px-2 py-1.5 border rounded text-sm">
                    {PIVOT_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Columns</label>
                  <select value={pivotConfig.colField} onChange={e => setPivotConfig({...pivotConfig, colField: e.target.value as any})}
                    className="w-full px-2 py-1.5 border rounded text-sm">
                    {PIVOT_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-500 mb-1">Values</label>
                  <select value={pivotConfig.valueField} onChange={e => setPivotConfig({...pivotConfig, valueField: e.target.value as any})}
                    className="w-full px-2 py-1.5 border rounded text-sm">
                    {PIVOT_VALUES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-3">
              <button onClick={handleBackendExport} disabled={exportLoading}
                className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
                <Download className="h-4 w-4" />{exportLoading ? 'Exporting...' : 'Server Export'}
              </button>
              <button onClick={handleFrontendExport}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600">
                <Download className="h-4 w-4" /> Client Export
              </button>
              <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
                <input type="checkbox" checked={multiSheet} onChange={e => setMultiSheet(e.target.checked)} /> Multi-sheet Excel
              </label>
            </div>
            <p className="text-xs text-gray-400">{storeReceipts.length} receipts loaded for client export</p>

            {error && <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 px-3 py-2 rounded"><AlertCircle className="h-4 w-4" />{error}</div>}
          </div>
        </div>
      )}

      {/* ── Backup Tab ── */}
      {activeTab === 'backup' && (
        <div className="space-y-6">
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-600" /> Export Backup
            </h2>
            <p className="text-sm text-gray-500">Create a complete backup of all your receipts, items, settings, and images.</p>
            <button onClick={handleExport} disabled={exporting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors">
              <Download className="h-4 w-4" />{exporting ? 'Creating backup...' : 'Export Full Backup'}
            </button>
            {exporting && (
              <div className="space-y-1">
                <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${exportProgress.pct}%` }} />
                </div>
                <p className="text-xs text-gray-500">{exportProgress.status} ({exportProgress.pct}%)</p>
              </div>
            )}
          </div>

          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <Upload className="h-5 w-5 text-green-600" /> Import / Restore Backup
            </h2>
            <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-blue-400 transition-colors">
              <FileArchive className="h-5 w-5 text-gray-400" />
              <span className="text-sm text-gray-600">{importFile ? importFile.name : 'Drop backup .tar.gz file'}</span>
              <input type="file" accept=".tar.gz,.gz,.tgz" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }} />
              {importFile && <button onClick={e => { e.preventDefault(); setImportFile(null); setPreview(null); }}
                className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-400"><X className="h-4 w-4" /></button>}
            </label>

            {importStep && (
              <div className="space-y-1">
                <div className="flex items-center gap-3 text-sm">
                  {importStep === 'importing' ? <RefreshCw className="h-4 w-4 animate-spin text-blue-500" /> :
                   importStep === 'done' ? <CheckCircle className="h-4 w-4 text-green-500" /> :
                   <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />}
                  <span className="text-gray-600">
                    {importStep === 'previewing' && 'Analyzing backup...'}
                    {importStep === 'importing' && 'Importing...'}
                    {importStep === 'done' && 'Import complete!'}
                  </span>
                </div>
                {importStep === 'importing' && <div className="h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-green-500 rounded-full animate-pulse" style={{ width: '100%' }} /></div>}
              </div>
            )}

            {preview && (
              <div className="space-y-4 border rounded-lg p-4 bg-gray-50">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-sm text-gray-700">Backup Preview</h3>
                  <span className="text-xs text-gray-500">{preview.size_kb} KB</span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-white rounded p-3 text-center"><div className="text-lg font-bold text-blue-600">{preview.receipt_count}</div><div className="text-xs text-gray-500">Receipts</div></div>
                  <div className="bg-white rounded p-3 text-center"><div className="text-lg font-bold text-green-600">{preview.image_count}</div><div className="text-xs text-gray-500">Images</div></div>
                  <div className="bg-white rounded p-3 text-center"><div className="text-lg font-bold text-purple-600">{preview.size_kb} KB</div><div className="text-xs text-gray-500">Size</div></div>
                  <div className="bg-white rounded p-3 text-center"><div className="text-lg font-bold text-amber-600">v{preview.manifest?.version || '?'}</div><div className="text-xs text-gray-500">Format</div></div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Conflict Resolution</h4>
                  <div className="flex flex-wrap gap-2">
                    {CONFLICT_MODES.map(mode => (
                      <button key={mode.value} onClick={() => setConflictMode(mode.value)}
                        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors border ${
                          conflictMode === mode.value ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`} title={mode.desc}>{mode.label}</button>
                    ))}
                  </div>
                </div>

                <button onClick={() => setShowDetail(!showDetail)}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-700">
                  {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  Receipts ({preview.receipt_count})
                  <span className="ml-2 text-blue-600 normal-case">{selectedIds.size > 0 ? `${selectedIds.size} selected` : 'All'}</span>
                </button>
                {showDetail && (
                  <div className="max-h-60 overflow-y-auto border rounded bg-white">
                    <label className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50 text-xs cursor-pointer hover:bg-gray-100">
                      <input type="checkbox" checked={selectedIds.size === preview.receipt_count} onChange={toggleAll} className="rounded" />
                      <span className="font-medium">Select All</span>
                    </label>
                    {preview.receipts.map(r => (
                      <label key={r.id} className="flex items-center gap-2 px-3 py-2 border-b last:border-0 text-xs cursor-pointer hover:bg-blue-50">
                        <input type="checkbox" checked={selectedIds.has(r.id)} onChange={() => toggleReceipt(r.id)} className="rounded" />
                        <span className="font-medium truncate flex-1">{r.supplier || 'Unknown'}</span>
                        <span className="text-gray-400">{r.totalAmount} KES</span>
                        <span className="text-gray-400">{r.receiptDate}</span>
                        {r.hasImage && <ImageIcon className="h-3 w-3 text-green-500" />}
                      </label>
                    ))}
                  </div>
                )}

                <button onClick={handleImport} disabled={importing || !importFile}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50">
                  <Upload className="h-4 w-4" />Import {selectedIds.size > 0 ? selectedIds.size : 'All'} Receipts</button>
              </div>
            )}

            {importResult && (
              <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                <h3 className="font-medium text-green-800 flex items-center gap-2 mb-3"><CheckCircle className="h-5 w-5" /> Import Complete</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="bg-white rounded p-2"><span className="font-bold text-green-600">{importResult.stats.receipts}</span> receipts</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-blue-600">{importResult.stats.items}</span> items</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-purple-600">{importResult.stats.images}</span> images</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-amber-600">{importResult.stats.skipped}</span> skipped</div>
                </div>
              </div>
            )}

            {error && <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 px-3 py-2 rounded"><AlertCircle className="h-4 w-4" />{error}</div>}
          </div>

          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2"><Clock className="h-5 w-5 text-amber-600" /> Backup History</h2>
            {loadingBackups ? <div className="flex items-center gap-2 text-sm text-gray-500"><RefreshCw className="h-4 w-4 animate-spin" /> Loading...</div>
             : backups.length === 0 ? <p className="text-sm text-gray-400">No backups yet.</p>
             : <div className="divide-y">
                {backups.map(b => (
                  <div key={b.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.filename}</p>
                      <p className="text-xs text-gray-400">{new Date(b.created_at).toLocaleString()} · {b.size_kb} KB</p>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={async () => { try { await backupApi.downloadBackup(b.id, b.filename); } catch(e) { setError(e instanceof Error ? e.message : 'Download failed'); } }} disabled={!b.available}
                        className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 disabled:opacity-30" title="Download"><Download className="h-4 w-4" /></button>
                      <button onClick={() => handleDeleteBackup(b.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50" title="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </div>
                ))}
              </div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
