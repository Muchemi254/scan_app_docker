// src/pages/ViewScansPage.tsx
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Hash, Calendar, Clock, Filter, X } from 'lucide-react';
import { useReceiptStore } from '../stores/receiptStore';
import ReviewPanel from '../components/ReviewPanel';
import type { ReceiptData } from '../types/gemini';
import ExportPage from './ExportPage';

const PAGE_SIZE = 25;

const isMissing = (val: any) =>
  !val || val === 'N/A' || val.toString().trim() === '';

const isComplete = (receipt: any) =>
  !isMissing(receipt.receiptDate) &&
  !isMissing(receipt.totalAmount) &&
  !isMissing(receipt.supplier) &&
  !isMissing(receipt.category) &&
  receipt.status === 'processed';

const ViewScansPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const { items: receipts, loading, load } = useReceiptStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [page, setPage] = useState(1);
  // Sidebar: open by default on lg+, closed on smaller screens
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [sortBy, setSortBy] = useState<'date' | 'scanned'>('scanned');
  const [filters, setFilters] = useState({
    category: '', supplier: '', status: '',
    isZeroRated: '', priceMin: '', priceMax: '',
    dateStart: '', dateEnd: '',
    scanDateStart: '', scanDateEnd: '',
  });

  const uniqueSuppliers = useMemo(
    () => [...new Set(receipts.map((r: any) => r.supplier).filter(Boolean))].sort(),
    [receipts],
  );
  const uniqueCategories = useMemo(
    () => [...new Set(receipts.map((r: any) => r.category).filter(Boolean))].sort(),
    [receipts],
  );

  useEffect(() => { if (userId) load(userId); }, [userId, load]);

  // Collapse sidebar when editing starts; restore on desktop when done
  useEffect(() => {
    if (isEditing) {
      setSidebarOpen(false);
    } else if (window.innerWidth >= 1024) {
      setSidebarOpen(true);
    }
  }, [isEditing]);

  useEffect(() => { setPage(1); }, [filters]);

  useEffect(() => {
    if (!selectedId && receipts.length > 0) setSelectedId(receipts[0].id);
  }, [receipts, selectedId]);

  const handleSelect = (id: string) => {
    if (isEditing && !confirm('Discard unsaved changes?')) return;
    setSelectedId(id);
    // On mobile/tablet: close sidebar after selecting so detail is visible
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const batchParam = new URLSearchParams(window.location.search).get('batch');

  const filteredReceipts = useMemo(() => {
    let result = (receipts as ReceiptData[]).filter(r => {
      const batchMatch = batchParam ? (r.batchTitle || '').trim() === batchParam : true;
      const categoryMatch = filters.category ? r.category === filters.category : true;
      const supplierMatch = filters.supplier ? r.supplier === filters.supplier : true;
      const statusMatch = filters.status
        ? filters.status === 'processed' ? isComplete(r) : !isComplete(r)
        : true;
      const zeroRatedMatch = filters.isZeroRated !== ''
        ? r.items?.some((i: any) => i.isZeroRated === (filters.isZeroRated === 'true'))
        : true;
      const priceMatch = (() => {
        const total = Number(r.totalAmount) || 0;
        return total >= (filters.priceMin ? Number(filters.priceMin) : 0)
            && total <= (filters.priceMax ? Number(filters.priceMax) : Infinity);
      })();
      const dateMatch = (() => {
        const d = new Date(r.receiptDate || '');
        const s = filters.dateStart ? new Date(filters.dateStart) : null;
        const e = filters.dateEnd   ? new Date(filters.dateEnd)   : null;
        return (!s || d >= s) && (!e || d <= e);
      })();
      const scanDateMatch = (() => {
        if (!r.scannedAt) return !filters.scanDateStart && !filters.scanDateEnd;
        const d = new Date(r.scannedAt);
        const s = filters.scanDateStart ? new Date(filters.scanDateStart) : null;
        const e = filters.scanDateEnd   ? new Date(filters.scanDateEnd)   : null;
        if (e) e.setHours(23, 59, 59, 999); // Include full end day
        return (!s || d >= s) && (!e || d <= e);
      })();
      return batchMatch && categoryMatch && supplierMatch && statusMatch && zeroRatedMatch && priceMatch && dateMatch && scanDateMatch;
    });

    // Apply Sorting
    result.sort((a, b) => {
      if (sortBy === 'date') {
        return new Date(b.receiptDate || 0).getTime() - new Date(a.receiptDate || 0).getTime();
      } else {
        return new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime();
      }
    });

    return result;
  }, [receipts, batchParam, filters, sortBy]);

  const totalPages   = Math.max(1, Math.ceil(filteredReceipts.length / PAGE_SIZE));
  const clampedPage  = Math.min(page, totalPages);
  const pageReceipts = filteredReceipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected     = filteredReceipts.find(r => r.id === selectedId);

  if (loading && receipts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
          <p className="text-gray-500 text-sm">Loading receipts…</p>
        </div>
      </div>
    );
  }

  /* ── Sidebar contents (shared between desktop inline & mobile overlay) ── */
  const SidebarBody = (
    <>
      {/* Sidebar header */}
      <div className="flex-shrink-0 flex flex-col border-b bg-gray-50">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b">
          <span className="text-sm font-semibold text-gray-700 truncate">
            Receipts
            <span className="ml-1.5 text-xs font-normal text-gray-400">{filteredReceipts.length}</span>
          </span>
          <button
            onClick={() => setSidebarOpen(false)}
            className="p-1 rounded hover:bg-gray-200 text-gray-500"
            title="Collapse"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>

        {/* Batch Indicator */}
        {batchParam && (
          <div className="px-3 py-2 bg-blue-600 text-white flex items-center justify-between shadow-inner">
            <div className="flex items-center gap-2 min-w-0">
              <Hash className="h-4 w-4 shrink-0" />
              <div className="flex flex-col min-w-0">
                <span className="text-[10px] uppercase tracking-wider opacity-80 leading-none">Viewing Batch</span>
                <span className="text-sm font-bold truncate leading-tight">{batchParam}</span>
              </div>
            </div>
            <button 
              onClick={() => navigate('/receipts')}
              className="p-1 hover:bg-white/20 rounded-full"
              title="Clear batch filter"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Sort Controls */}
        <div className="px-3 py-2 flex items-center gap-2 border-b bg-white">
          <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Sort By:</span>
          <button 
            onClick={() => setSortBy('scanned')}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
              sortBy === 'scanned' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            <Clock className="h-3 w-3" />
            Scanned
          </button>
          <button 
            onClick={() => setSortBy('date')}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
              sortBy === 'date' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200' : 'text-gray-500 hover:bg-gray-100'
            }`}
          >
            <Calendar className="h-3 w-3" />
            Receipt
          </button>
        </div>
      </div>

      {/* Receipt list */}
      <div className="flex-1 overflow-y-auto divide-y bg-white">
        {pageReceipts.length === 0 ? (
          <p className="p-4 text-sm text-gray-400">No receipts match your filters.</p>
        ) : pageReceipts.map(receipt => (
          <div
            key={receipt.id}
            onClick={() => handleSelect(receipt.id)}
            className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
              selectedId === receipt.id
                ? 'bg-blue-50 border-blue-500'
                : 'border-transparent hover:bg-gray-50'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-sm truncate text-gray-900">{receipt.supplier}</span>
              <span
                className={`shrink-0 w-2 h-2 rounded-full ${isComplete(receipt) ? 'bg-green-500' : 'bg-red-500'}`}
                title={isComplete(receipt) ? 'Processed' : 'Needs review'}
              />
            </div>
            
            <div className="flex flex-col gap-0.5 mt-1">
              <div className="flex items-center gap-1.5 text-xs text-gray-500">
                <Calendar className="h-3 w-3 shrink-0" />
                <span>{receipt.receiptDate}</span>
              </div>
              {receipt.scannedAt && (
                <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                  <Clock className="h-2.5 w-2.5 shrink-0" />
                  <span>Scanned: {new Date(receipt.scannedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                </div>
              )}
            </div>
            <div className="text-sm text-blue-600 font-bold mt-2 leading-none">KES {Number(receipt.totalAmount).toLocaleString()}</div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>
          {filteredReceipts.length === 0
            ? '0'
            : `${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, filteredReceipts.length)}`
          } / {filteredReceipts.length}
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

      {/* Export modal */}
      {showExportModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <ExportPage userId={userId} customReceipts={filteredReceipts} onClose={() => setShowExportModal(false)} />
          </div>
        </div>
      )}

      {/* ── Top filter bar ── */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
        {/* Sidebar toggle (always visible) */}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600"
          title={sidebarOpen ? 'Collapse list' : 'Expand list'}
        >
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <span className="flex-shrink-0 font-semibold text-sm text-gray-700 mr-1">
          All Receipts
        </span>

        {/* Filters */}
        <div className="flex flex-wrap gap-2 flex-1 min-w-0">
          <select value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white">
            <option value="">All Categories</option>
            {uniqueCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.supplier} onChange={e => setFilters(f => ({ ...f, supplier: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white">
            <option value="">All Suppliers</option>
            {uniqueSuppliers.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white">
            <option value="">All Statuses</option>
            <option value="processed">Processed</option>
            <option value="needs_review">Needs Review</option>
          </select>
          <input type="date" value={filters.dateStart} onChange={e => setFilters(f => ({ ...f, dateStart: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Receipt Date Start" />
          <input type="date" value={filters.dateEnd}   onChange={e => setFilters(f => ({ ...f, dateEnd:   e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Receipt Date End" />
          
          <div className="flex items-center gap-1 border-l pl-2 ml-1">
            <span className="text-[10px] font-bold text-gray-400 uppercase">Scan:</span>
            <input type="date" value={filters.scanDateStart} onChange={e => setFilters(f => ({ ...f, scanDateStart: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Scan Date Start" />
            <input type="date" value={filters.scanDateEnd}   onChange={e => setFilters(f => ({ ...f, scanDateEnd:   e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Scan Date End" />
          </div>

          {Object.values(filters).some(Boolean) && (
            <button
              onClick={() => setFilters({ category: '', supplier: '', status: '', isZeroRated: '', priceMin: '', priceMax: '', dateStart: '', dateEnd: '', scanDateStart: '', scanDateEnd: '' })}
              className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50"
            >Clear</button>
          )}
        </div>

        <button
          onClick={() => setShowExportModal(true)}
          className="flex-shrink-0 px-3 py-1.5 text-xs sm:text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Export
        </button>
      </div>

      {/* ── Main body: sidebar + detail ── */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* Desktop sidebar (inline, width-transitions) */}
        <div className={`hidden lg:flex flex-col flex-shrink-0 bg-white border-r transition-[width] duration-200 overflow-hidden ${sidebarOpen ? 'w-64 xl:w-72' : 'w-0'}`}>
          {SidebarBody}
        </div>

        {/* Mobile/tablet sidebar (overlay from left) */}
        <>
          <div className={`lg:hidden fixed top-16 bottom-0 left-0 z-50 w-72 flex flex-col bg-white shadow-2xl transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {SidebarBody}
          </div>
          {sidebarOpen && (
            <div
              className="lg:hidden fixed inset-0 top-16 bg-black/40 z-40"
              onClick={() => setSidebarOpen(false)}
            />
          )}
        </>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <ReviewPanel
              userId={userId!}
              receipt={selected}
              setIsEditing={setIsEditing}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ViewScansPage;
