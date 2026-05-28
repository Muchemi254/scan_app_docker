import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { reviewBatchApi, type ReviewBatch } from '../services/reviewBatchApi';
import { receiptApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import type { ReceiptData } from '../types/gemini';
import ReviewPanel from '../components/ReviewPanel';
import SearchBar from '../components/SearchBar';
import { ChevronLeft, ChevronRight, CheckCircle, Clock, Eye, Flag, AlertCircle, Download, X } from 'lucide-react';

const STATUS_OPTS = [
  { value: 'pending_review', label: 'Pending', icon: Clock, color: 'bg-amber-100 text-amber-700 border-amber-400' },
  { value: 'in_review', label: 'In Review', icon: Eye, color: 'bg-blue-100 text-blue-700 border-blue-400' },
  { value: 'reviewed', label: 'Reviewed', icon: CheckCircle, color: 'bg-green-100 text-green-700 border-green-400' },
  { value: 'flagged', label: 'Flagged', icon: Flag, color: 'bg-red-100 text-red-700 border-red-400' },
] as const;

const EXPORT_FORMATS = [
  { value: 'xlsx', label: 'Excel', color: 'bg-green-100 text-green-700 hover:bg-green-200' },
  { value: 'csv', label: 'CSV', color: 'bg-blue-100 text-blue-700 hover:bg-blue-200' },
  { value: 'pdf', label: 'PDF', color: 'bg-red-100 text-red-700 hover:bg-red-200' },
] as const;

const EXPORT_TYPES = [
  { value: 'detailed', label: 'Detailed' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'summary', label: 'Summary' },
  { value: 'itemized', label: 'Itemized' },
] as const;

const PAGE_SIZE = 25;

/** Composite item: store receipt data + SQLite review status. */
interface BatchReviewItem {
  receipt: ReceiptData;
  review_status: string;
  reviewer_notes: string | null;
  reviewed_at: string | null;
}

const ReviewBatchDetailPage = ({ userId }: { userId: string | null }) => {
  const { batchId } = useParams<{ batchId: string }>();
  const navigate = useNavigate();

  // ── Store (same data source as ReviewPage) ──
  const { items: storeReceipts, loading: storeLoading, load } = useReceiptStore();

  // ── Local state ──
  const [batch, setBatch] = useState<ReviewBatch | null>(null);
  const [batchLoading, setBatchLoading] = useState(true);
  const [batchError, setBatchError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [page, setPage] = useState(1);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState('xlsx');
  const [exportType, setExportType] = useState('detailed');

  // Search
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);

  const onSearchResults = (results: any[], total: number) => {
    setSearchResults(results);
    setSearchTotal(total);
    setPage(1);
  };

  const onSearchClear = () => {
    setSearchResults(null);
    setSearchTotal(0);
    setPage(1);
  };

  // ── Load store receipts + batch metadata ──
  const loadAll = useCallback(async () => {
    if (!userId || !batchId) return;
    try {
      setBatchLoading(true);
      setBatchError('');
      // Load receipts into the global store (same as ReviewPage)
      await load(userId);
      // Fetch batch metadata from SQLite
      const data = await reviewBatchApi.get(batchId);
      setBatch(data);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Failed to load batch');
    } finally {
      setBatchLoading(false);
    }
  }, [userId, batchId, load]);

  useEffect(() => {
    if (!userId) return;
    loadAll();
  }, [userId, loadAll]);

  // ── Trigger background image prefetch when batch is loaded ──
  useEffect(() => {
    if (!batchId || !batch) return;
    reviewBatchApi.prefetchImages(batchId).catch(() => {});
  }, [batchId, batch?.id]);

  // ── Build composite list: match store receipts with batch items ──
  const batchItems: BatchReviewItem[] = (batch?.items || [])
    .map(item => {
      const receipt = storeReceipts.find(r => r.id === item.receipt_id) as ReceiptData | undefined;
      return receipt
        ? { receipt, review_status: item.review_status, reviewer_notes: item.reviewer_notes, reviewed_at: item.reviewed_at }
        : null;
    })
    .filter(Boolean) as BatchReviewItem[];

  // ── When searching, filter batchItems to matching receipts ──
  const filteredBatchItems = useMemo(() => {
    if (searchResults === null) return batchItems;
    const searchIds = new Set(searchResults.map((r: any) => r.id));
    return batchItems.filter(bi => searchIds.has(bi.receipt.id));
  }, [batchItems, searchResults]);

  // Count receipts NOT found in store
  const missingCount = (batch?.items || []).length - batchItems.length;

  // ── Sidebar collapse while editing (same as ReviewPage) ──
  useEffect(() => {
    if (isEditing) {
      setSidebarOpen(false);
    } else if (window.innerWidth >= 1024) {
      setSidebarOpen(true);
    }
  }, [isEditing]);

  // ── Auto-select first item ──
  useEffect(() => {
    if (!selectedId && filteredBatchItems.length > 0) {
      setSelectedId(filteredBatchItems[0].receipt.id);
    }
  }, [filteredBatchItems, selectedId]);

  // ── Selection (same pattern as ReviewPage) ──
  const handleSelect = (newId: string) => {
    if (isEditing) {
      if (!confirm('You have unsaved changes. Do you want to discard them and switch receipts?')) return;
    }
    setSelectedId(newId);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // Fetch full receipt with items from API when selection changes
  // (store data from list endpoint does not include items)
  useEffect(() => {
    if (!selectedId || !batch) return;
    const fetchFull = async () => {
      try {
        const fullReceipt = await receiptApi.get(selectedId);
        setBatch(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            items: prev.items?.map(item =>
              item.receipt_id === selectedId
                ? { ...item, receipt: fullReceipt }
                : item
            ),
          };
        });
      } catch (e) {
        // receipt may have been deleted — ignore
      }
    };
    fetchFull();
  }, [selectedId, batch?.id]);

  // ── Pagination ──
  const totalPages = Math.max(1, Math.ceil(filteredBatchItems.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = filteredBatchItems.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected = filteredBatchItems.find(bi => bi.receipt.id === selectedId);

  // ── Remove item from batch ──
  const handleRemoveItem = async (e: React.MouseEvent, receiptId: string) => {
    e.stopPropagation();
    if (!batchId) return;
    try {
      await reviewBatchApi.removeItem(batchId, receiptId);
      // If removing the selected receipt, clear selection
      if (selectedId === receiptId) setSelectedId(null);
      // Remove from local state
      setBatch(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items?.filter(item => item.receipt_id !== receiptId),
        };
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to remove item');
    }
  };

  // ── Review status update ──
  const updateStatus = async (receiptId: string, status: string) => {
    if (!batchId) return;
    try {
      setStatusUpdating(true);
      await reviewBatchApi.updateStatus(batchId, receiptId, status);
      setBatch(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items?.map(item =>
            item.receipt_id === receiptId ? { ...item, review_status: status as any } : item
          ),
        };
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Status update failed');
    } finally {
      setStatusUpdating(false);
    }
  };

  // ── Export ──
  const handleExport = async () => {
    if (!batchId) return;
    try {
      setExporting(true);
      await reviewBatchApi.exportBatch(batchId, {
        format: exportFormat as any,
        reportType: exportType,
        columns: exportType === 'receipts' ? ['supplier', 'totalAmount', 'taxAmount', 'receiptDate', 'category', 'invoiceNumber', 'kraPin', 'buyerKraPin', 'cuInvoice', 'batchTitle', 'status'] : undefined,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const reviewedCount = batchItems.filter(i => i.review_status === 'reviewed').length;
  const pct = batchItems.length > 0 ? Math.round((reviewedCount / batchItems.length) * 100) : 0;

  // ═══════════════════════════════════════════════════════════════════════
  // Loading state (same pattern as ReviewPage)
  // ═══════════════════════════════════════════════════════════════════════
  if ((storeLoading || batchLoading) && batchItems.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
          <p className="text-gray-500">Loading batch...</p>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Error state
  // ═══════════════════════════════════════════════════════════════════════
  if (batchError) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center max-w-md px-4">
          <AlertCircle className="h-12 w-12 text-red-300 mx-auto mb-3" />
          <p className="text-red-600 font-medium">Failed to load batch</p>
          <p className="text-gray-500 text-sm mt-1">{batchError}</p>
          <div className="flex gap-2 justify-center mt-4">
            <button onClick={() => navigate('/review-batches')} className="px-4 py-2 text-sm border rounded hover:bg-gray-50">Back</button>
            <button onClick={loadAll} className="px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600">Retry</button>
          </div>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Empty state (same pattern as ReviewPage)
  // ═══════════════════════════════════════════════════════════════════════
  if (!storeLoading && !batchLoading && batchItems.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">
            {missingCount > 0 ? '⚠️' : '✅'}
          </div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">
            {missingCount > 0 ? 'Receipts Not Found' : 'Nothing to Review'}
          </h2>
          <p className="text-gray-500 text-sm">
            {missingCount > 0
              ? `${missingCount} receipt ID(s) from the CSV don't match any receipts in your account. They may have been deleted.`
              : 'No matching receipts found for this batch.'}
          </p>
          <button onClick={() => navigate('/review-batches')} className="mt-4 text-blue-500 text-sm hover:underline">
            Back to batches
          </button>
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Sidebar (same pattern as ReviewPage)
  // ═══════════════════════════════════════════════════════════════════════
  const SidebarBody = (
    <>
      {/* Sidebar header */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b bg-gray-50">
        <button onClick={() => navigate('/review-batches')} className="p-1 rounded hover:bg-gray-200 text-gray-500" title="Back to batches">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-semibold text-gray-700 truncate flex-1">
          {batch?.name || 'Batch'}
          <span className="ml-1.5 text-xs font-normal text-gray-400">{filteredBatchItems.length}</span>
        </span>
        <button
          onClick={() => setSidebarOpen(false)}
          className="p-1 rounded hover:bg-gray-200 text-gray-500"
          title="Collapse"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Search */}
      <div className="flex-shrink-0 px-3 py-2 border-b bg-white">
        <SearchBar
          placeholder="Search receipts in this batch..."
          onResults={onSearchResults}
          onClear={onSearchClear}
        />
      </div>

      {/* Progress bar */}
      <div className="flex-shrink-0 px-3 py-2 border-b bg-white">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>{reviewedCount} of {batchItems.length} reviewed</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* Receipt list (same pattern as ReviewPage) */}
      <div className="flex-1 overflow-y-auto divide-y">
        {pageItems.map(bi => {
          const r = bi.receipt;
          const isSelected = r.id === selectedId;
          const statusCfg = STATUS_OPTS.find(s => s.value === bi.review_status) || STATUS_OPTS[0];
          const StatusIcon = statusCfg.icon;

          return (
            <div
              key={r.id}
              onClick={() => handleSelect(r.id)}
              className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
                isSelected ? 'bg-blue-50 border-blue-500' : 'border-transparent hover:bg-gray-50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-sm truncate">{r.supplier}</div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-medium ${statusCfg.color}`}>
                    <StatusIcon className="h-3 w-3" />
                  </span>
                  <button
                    onClick={(e) => handleRemoveItem(e, r.id)}
                    className="p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                    title="Remove from batch"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">{r.receiptDate}</div>
              <div className="text-xs text-gray-600 font-medium">{r.totalAmount} KES</div>
              <div className="text-xs mt-0.5 flex gap-2">
                {r.cuInvoice && <span className="text-blue-600 font-medium">CU: {r.cuInvoice}</span>}
                {r.invoiceNumber && <span className="text-gray-500">INV: {r.invoiceNumber}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination (same pattern as ReviewPage) */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>
          {`${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, filteredBatchItems.length)}`}
          {' '}/ {filteredBatchItems.length}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={clampedPage === 1}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100"
          >‹</button>
          <span className="px-1">{clampedPage}/{totalPages}</span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={clampedPage >= totalPages}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100"
          >›</button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col w-full h-[calc(100vh-4rem)] bg-gray-100">
      {/* ── Top bar (same pattern as ReviewPage) ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
        <button
          onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600"
          title={sidebarOpen ? 'Collapse list' : 'Expand list'}
        >
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="font-semibold text-sm text-gray-700 truncate">{batch?.name || 'Batch'}</span>
        <span className="text-xs text-gray-400 flex-shrink-0">{reviewedCount}/{batchItems.length} reviewed</span>
        {missingCount > 0 && (
          <span className="text-xs text-amber-600 flex-shrink-0">({missingCount} not found)</span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <select
            value={exportType}
            onChange={e => setExportType(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white text-gray-600 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            {EXPORT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <select
            value={exportFormat}
            onChange={e => setExportFormat(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1.5 bg-white text-gray-600 focus:ring-1 focus:ring-blue-500 outline-none"
          >
            {EXPORT_FORMATS.map(f => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting || batchItems.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-50 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? 'Exporting...' : 'Export'}
          </button>
        </div>
      </div>

      {/* ── Main body: sidebar + detail ── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Desktop sidebar (same width as ReviewPage) */}
        <div className={`hidden lg:flex flex-col flex-shrink-0 bg-white border-r transition-[width] duration-200 overflow-hidden ${sidebarOpen ? 'w-64 xl:w-72' : 'w-0'}`}>
          {SidebarBody}
        </div>

        {/* Mobile overlay sidebar */}
        <>
          <div className={`lg:hidden fixed top-16 bottom-0 left-0 z-50 w-72 flex flex-col bg-white shadow-2xl transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {SidebarBody}
          </div>
          {sidebarOpen && (
            <div className="lg:hidden fixed inset-0 top-16 bg-black/40 z-40" onClick={() => setSidebarOpen(false)} />
          )}
        </>

        {/* Detail panel — ReviewPanel with review status controls */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {!selected ? (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to review
            </div>
          ) : (
            <div className="flex flex-col h-full">
              {/* Review status controls */}
              <div className="flex-shrink-0 bg-white border-b px-4 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-gray-500 mr-1">Review:</span>
                  {STATUS_OPTS.map(opt => {
                    const Icon = opt.icon;
                    const isActive = selected.review_status === opt.value;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => updateStatus(selected.receipt.id, opt.value)}
                        disabled={statusUpdating}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                          isActive ? opt.color : 'border-gray-200 bg-gray-50 text-gray-500 hover:bg-gray-100'
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* ReviewPanel (exact same component as ReviewPage) */}
              <div className="flex-1 overflow-y-auto">
                <ReviewPanel
                  userId={userId!}
                  receipt={selected.receipt}
                  setIsEditing={setIsEditing}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReviewBatchDetailPage;
