import { useEffect, useState, useCallback } from 'react';
import { backupApi, type BackupEntry, type BackupPreview, type ImportResult } from '../services/backupApi';
import {
  Download, Upload, Trash2, RefreshCw, FileArchive,
  CheckCircle, AlertCircle, Clock, Database, Image, Shield,
  ChevronDown, ChevronRight, X,
} from 'lucide-react';

type Tab = 'backup';

const CONFLICT_MODES = [
  { value: 'skip', label: 'Skip existing', desc: 'Import only new receipts, keep current data' },
  { value: 'overwrite', label: 'Overwrite all', desc: 'Replace all existing receipts with backup data' },
  { value: 'merge', label: 'Merge (update only)', desc: 'Update existing receipts, add new ones' },
] as const;

const SettingsPage = ({ userId }: { userId: string | null }) => {
  const [activeTab, setActiveTab] = useState<Tab>('backup');

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
  const [importStep, setImportStep] = useState<string>('');  // '' | 'uploading' | 'previewing' | 'importing' | 'done'
  const [error, setError] = useState('');
  const [showDetail, setShowDetail] = useState(false);

  const loadBackups = useCallback(async () => {
    try {
      setLoadingBackups(true);
      setError('');
      const list = await backupApi.listBackups();
      setBackups(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load backups');
    } finally {
      setLoadingBackups(false);
    }
  }, []);

  useEffect(() => { if (userId) loadBackups(); }, [userId, loadBackups]);

  const handleExport = async () => {
    try { setExporting(true); setError(''); setExportProgress({pct:0,status:'Starting...'});
      await backupApi.exportBackup((pct, status) => setExportProgress({pct, status}));
      await loadBackups(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Export failed'); }
    finally { setExporting(false); }
  };

  const handleFileSelect = async (file: File) => {
    setImportFile(file);
    setImportResult(null);
    setSelectedIds(new Set());
    setImportStep('previewing');
    try {
      setPreviewing(true);
      const p = await backupApi.previewBackup(file);
      setPreview(p);
      setError('');
      setImportStep('');
    } catch (e) {
      setPreview(null);
      setImportStep('');
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const handleImport = async () => {
    if (!importFile) return;
    try {
      setImporting(true);
      setImportStep('importing');
      const ids = selectedIds.size > 0 ? Array.from(selectedIds) : undefined;
      const result = await backupApi.importBackup(importFile, conflictMode, ids);
      setImportResult(result);
      setImportStep('done');
      setError('');
    } catch (e) {
      setImportStep('');
      setError(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleDeleteBackup = async (backupId: string) => {
    if (!confirm('Delete this backup?')) return;
    try { await backupApi.deleteBackup(backupId); await loadBackups(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Delete failed'); }
  };

  const toggleReceipt = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!preview) return;
    if (selectedIds.size === preview.receipt_count) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(preview.receipts.map(r => r.id)));
    }
  };

  if (!userId) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {([
          { key: 'backup', label: 'Backup & Restore', icon: Shield },
        ] as const).map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Backup Tab ── */}
      {activeTab === 'backup' && (
        <div className="space-y-6">
          {/* Export */}
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <Database className="h-5 w-5 text-blue-600" />
              Export Backup
            </h2>
            <p className="text-sm text-gray-500">
              Create a complete backup of all your receipts, items, settings, and images.
              Download as a single .tar.gz file for safekeeping or transfer.
            </p>
            <button
              onClick={handleExport}
              disabled={exporting}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 transition-colors"
            >
              <Download className="h-4 w-4" />
              {exporting ? 'Creating backup...' : 'Export Full Backup'}
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

          {/* Import */}
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <Upload className="h-5 w-5 text-green-600" />
              Import / Restore Backup
            </h2>
            <p className="text-sm text-gray-500">
              Restore receipts and images from a backup file. First upload to preview,
              then choose which receipts to import and how to handle conflicts.
            </p>

            {/* File input */}
            <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed rounded-lg cursor-pointer hover:border-blue-400 transition-colors">
              <FileArchive className="h-5 w-5 text-gray-400" />
              <span className="text-sm text-gray-600">
                {importFile ? importFile.name : 'Drop backup .tar.gz file or click to browse'}
              </span>
              <input
                type="file"
                accept=".tar.gz,.gz,.tgz"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) handleFileSelect(f);
                }}
              />
              {importFile && (
                <button
                  onClick={e => { e.preventDefault(); setImportFile(null); setPreview(null); }}
                  className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-400"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>

            {/* Import step indicator */}
            {importStep && (
              <div className="space-y-1">
                <div className="flex items-center gap-3 text-sm">
                  {importStep === 'importing' ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-blue-500" />
                  ) : importStep === 'done' ? (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  ) : importStep === 'previewing' ? (
                    <RefreshCw className="h-4 w-4 animate-spin text-amber-500" />
                  ) : null}
                  <span className="text-gray-600">
                    {importStep === 'previewing' && 'Analyzing backup file...'}
                    {importStep === 'importing' && 'Importing receipts and images...'}
                    {importStep === 'done' && 'Import complete!'}
                  </span>
                </div>
                {importStep === 'importing' && (
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full animate-pulse" style={{ width: '100%' }} />
                  </div>
                )}
              </div>
            )}

            {/* Preview loading */}
            {previewing && (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Analyzing backup...
              </div>
            )}

            {/* Preview result */}
            {preview && (
              <div className="space-y-4 border rounded-lg p-4 bg-gray-50">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium text-sm text-gray-700">Backup Preview</h3>
                  <span className="text-xs text-gray-500">{preview.size_kb} KB</span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-bold text-blue-600">{preview.receipt_count}</div>
                    <div className="text-xs text-gray-500">Receipts</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-bold text-green-600">{preview.image_count}</div>
                    <div className="text-xs text-gray-500">Images</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-bold text-purple-600">{preview.size_kb} KB</div>
                    <div className="text-xs text-gray-500">Size</div>
                  </div>
                  <div className="bg-white rounded p-3 text-center">
                    <div className="text-lg font-bold text-amber-600">v{preview.manifest?.version || '?'}</div>
                    <div className="text-xs text-gray-500">Format</div>
                  </div>
                </div>

                {/* Conflict mode */}
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Conflict Resolution</h4>
                  <div className="flex flex-wrap gap-2">
                    {CONFLICT_MODES.map(mode => (
                      <button
                        key={mode.value}
                        onClick={() => setConflictMode(mode.value)}
                        className={`px-3 py-1.5 rounded text-xs font-medium transition-colors border ${
                          conflictMode === mode.value
                            ? 'bg-blue-50 border-blue-300 text-blue-700'
                            : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                        }`}
                        title={mode.desc}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    {CONFLICT_MODES.find(m => m.value === conflictMode)?.desc}
                  </p>
                </div>

                {/* Receipt list */}
                <div>
                  <button
                    onClick={() => setShowDetail(!showDetail)}
                    className="flex items-center gap-1 text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 hover:text-gray-700"
                  >
                    {showDetail ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Receipt List ({preview.receipt_count})
                    <span className="ml-2 text-blue-600 normal-case">
                      {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'All'}
                    </span>
                  </button>
                  {showDetail && (
                    <div className="max-h-60 overflow-y-auto border rounded bg-white">
                      <label className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50 text-xs cursor-pointer hover:bg-gray-100">
                        <input
                          type="checkbox"
                          checked={selectedIds.size === preview.receipt_count}
                          onChange={toggleAll}
                          className="rounded"
                        />
                        <span className="font-medium">Select All / None</span>
                      </label>
                      {preview.receipts.map(r => (
                        <label
                          key={r.id}
                          className="flex items-center gap-2 px-3 py-2 border-b last:border-0 text-xs cursor-pointer hover:bg-blue-50"
                        >
                          <input
                            type="checkbox"
                            checked={selectedIds.has(r.id)}
                            onChange={() => toggleReceipt(r.id)}
                            className="rounded"
                          />
                          <span className="font-medium truncate flex-1">{r.supplier || 'Unknown'}</span>
                          <span className="text-gray-400">{r.totalAmount} KES</span>
                          <span className="text-gray-400">{r.receiptDate}</span>
                          {r.hasImage && <Image className="h-3 w-3 text-green-500" />}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <button
                  onClick={handleImport}
                  disabled={importing || !importFile}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
                >
                  <Upload className="h-4 w-4" />
                  {importing ? 'Importing...' : `Import ${selectedIds.size > 0 ? selectedIds.size : 'All'} Receipts`}
                </button>
              </div>
            )}

            {/* Import result */}
            {importResult && (
              <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                <h3 className="font-medium text-green-800 flex items-center gap-2 mb-3">
                  <CheckCircle className="h-5 w-5" /> Import Complete
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="bg-white rounded p-2"><span className="font-bold text-green-600">{importResult.stats.receipts}</span> receipts</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-blue-600">{importResult.stats.items}</span> items</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-purple-600">{importResult.stats.images}</span> images</div>
                  <div className="bg-white rounded p-2"><span className="font-bold text-amber-600">{importResult.stats.skipped}</span> skipped</div>
                </div>
                {importResult.stats.errors > 0 && (
                  <p className="text-xs text-red-500 mt-2">{importResult.stats.errors} errors during import</p>
                )}
              </div>
            )}

            {/* Error display */}
            {error && (
              <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 px-3 py-2 rounded">
                <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
              </div>
            )}
          </div>

          {/* Backup History */}
          <div className="bg-white rounded-lg shadow p-6 space-y-4">
            <h2 className="font-semibold text-gray-800 flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-600" />
              Backup History
            </h2>

            {loadingBackups ? (
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <RefreshCw className="h-4 w-4 animate-spin" /> Loading...
              </div>
            ) : backups.length === 0 ? (
              <p className="text-sm text-gray-400">No backups yet. Export one above.</p>
            ) : (
              <div className="divide-y">
                {backups.map(b => (
                  <div key={b.id} className="flex items-center justify-between gap-3 py-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{b.filename}</p>
                      <p className="text-xs text-gray-400">
                        {new Date(b.created_at).toLocaleString()} · {b.size_kb} KB
                        {!b.available && <span className="text-red-400 ml-1">(unavailable)</span>}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => backupApi.downloadBackup(b.id, b.filename)}
                        disabled={!b.available}
                        className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 disabled:opacity-30"
                        title="Download"
                      >
                        <Download className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDeleteBackup(b.id)}
                        className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
