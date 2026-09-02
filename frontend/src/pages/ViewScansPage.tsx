// src/pages/ViewScansPage.tsx
import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Hash, Calendar, Clock, X, Table2, LayoutGrid } from 'lucide-react';
import { useReceiptStore } from '../stores/receiptStore';
import { useAuthStore } from '../stores/authStore';
import { receiptApi } from '../services/api';
import ReviewPanel from '../components/ReviewPanel';
import SearchBar from '../components/SearchBar';
import ReceiptsTableView from '../components/ReceiptsTableView';
import ExportNameModal from '../components/ExportNameModal';
import { exportRowsAsCsv, visibleColumnKeys, defaultExportName } from '../utils/exportTableCsv';
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
  const { user } = useAuthStore();
  const isAdmin = !!user?.is_admin;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [page, setPage] = useState(1);
  // Sidebar: open by default on lg+, closed on smaller screens
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [sortBy, setSortBy] = useState<'date' | 'scanned'>('scanned');

  // Table view (default) — server-side paginated, respects the same top-bar filters
  const VIEW_KEY = 'scanapp-receipts-view';
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() =>
    localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  );
  const [tPage, setTPage] = useState(1);
  const [tPageSize, setTPageSize] = useState(50);
  const [tSortBy, setTSortBy] = useState<string | null>(null);
  const [tSortOrder, setTSortOrder] = useState<'asc' | 'desc'>('desc');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [tableExporting, setTableExporting] = useState(false);
  const [tableModalReceipt, setTableModalReceipt] = useState<any | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
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
    setSearchQuery('');
    setPage(1);
  };

  const loadSearchPage = async (pageNum: number) => {
    if (!searchQuery.trim()) return;
    try {
      const offset = (pageNum - 1) * PAGE_SIZE;
      const r = await receiptApi.search(searchQuery.trim(), PAGE_SIZE, offset, {
        category: filters.category || undefined,
        supplier: filters.supplier || undefined,
        batchTitle: batchParam || undefined,
        dateFrom: filters.dateStart || undefined,
        dateTo: filters.dateEnd || undefined,
        complete: filters.status ? filters.status === 'processed' : undefined,
        zeroRated: filters.isZeroRated !== '' ? filters.isZeroRated === 'true' : undefined,
        priceMin: filters.priceMin ? Number(filters.priceMin) : undefined,
        priceMax: filters.priceMax ? Number(filters.priceMax) : undefined,
        scanDateFrom: filters.scanDateStart || undefined,
        scanDateTo: filters.scanDateEnd || undefined,
      });
      setSearchResults(r.results || []);
      setSearchTotal(r.total || 0);
    } catch (_) { /* search failure: fall back to local receipts */ }
  };

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

  useEffect(() => { setPage(1); setTPage(1); }, [filters, searchResults]);

  useEffect(() => {
    if (!selectedId && receipts.length > 0) setSelectedId(receipts[0].id);
  }, [receipts, selectedId]);

  const handleSelect = (id: string) => {
    if (isEditing && !confirm('Discard unsaved changes?')) return;
    setSelectedId(id);
    // On mobile/tablet: close sidebar after selecting so detail is visible
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // After a delete, move panel and optimistically remove from search results (store handles main list)
  const handleDeleted = (id: string) => {
    setSelectedId(null);
    if (searchResults !== null) {
      setSearchResults(prev => prev ? prev.filter((r: any) => r.id !== id) : prev);
      setSearchTotal(t => Math.max(0, t - 1));
    }
    const remaining = receipts.filter(r => r.id !== id);
    if (remaining.length > 0) setSelectedId(remaining[0].id);
  };

  const batchParam = new URLSearchParams(window.location.search).get('batch');
  const searchKey = JSON.stringify({ batchParam, filters });
  const searchFilters = {
    category: filters.category || undefined,
    supplier: filters.supplier || undefined,
    batchTitle: batchParam || undefined,
    dateFrom: filters.dateStart || undefined,
    dateTo: filters.dateEnd || undefined,
    complete: filters.status ? filters.status === 'processed' : undefined,
    zeroRated: filters.isZeroRated !== '' ? filters.isZeroRated === 'true' : undefined,
    priceMin: filters.priceMin ? Number(filters.priceMin) : undefined,
    priceMax: filters.priceMax ? Number(filters.priceMax) : undefined,
    scanDateFrom: filters.scanDateStart || undefined,
    scanDateTo: filters.scanDateEnd || undefined,
  };

  const parseReceiptTs = (v: string) => {
    if (!v) return null;
    const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
    const iso = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime();
    const t = Date.parse(String(v));
    return isNaN(t) ? null : t;
  };
  const parseFilterBound = (v: string, end: boolean) => {
    if (!v) return null;
    const [yy, mm, dd] = v.split('-').map(Number);
    if (!yy || !mm || !dd) return null;
    const d = new Date(yy, mm - 1, dd);
    if (end) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d.getTime();
  };

  const filteredReceipts = useMemo(() => {
    // If searching, use server results directly
    if (searchResults !== null) {
      return [...searchResults].sort((a: any, b: any) => (b._search_rank || 0) - (a._search_rank || 0));
    }

    const result = (receipts as ReceiptData[]).filter(r => {
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
        if (!filters.dateStart && !filters.dateEnd) return true;
        const ts = parseReceiptTs(r.receiptDate || '');
        if (ts === null) return false;
        const s = parseFilterBound(filters.dateStart, false);
        const e = parseFilterBound(filters.dateEnd, true);
        return (s === null || ts >= s) && (e === null || ts <= e);
      })();
      const scanDateMatch = (() => {
        if (!filters.scanDateStart && !filters.scanDateEnd) return true;
        if (!r.scannedAt) return false;
        const ts = new Date(r.scannedAt).getTime();
        if (isNaN(ts)) return false;
        const s = parseFilterBound(filters.scanDateStart, false);
        const e = parseFilterBound(filters.scanDateEnd, true);
        return (s === null || ts >= s) && (e === null || ts <= e);
      })();
      return batchMatch && categoryMatch && supplierMatch && statusMatch && zeroRatedMatch && priceMatch && dateMatch && scanDateMatch;
    });

    // Apply Sorting
    result.sort((a, b) => {
      if (sortBy === 'date') {
        const at = parseReceiptTs(b.receiptDate || '') ?? 0;
        const bt = parseReceiptTs(a.receiptDate || '') ?? 0;
        return at - bt;
      } else {
        return new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime();
      }
    });

    return result;
  }, [receipts, batchParam, filters, sortBy, searchResults]);

  const totalPages   = Math.max(1, Math.ceil((searchResults !== null ? searchTotal : filteredReceipts.length) / PAGE_SIZE));
  const clampedPage  = Math.min(page, totalPages);
  const pageReceipts = searchResults !== null
    ? filteredReceipts
    : filteredReceipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected     = filteredReceipts.find(r => r.id === selectedId);

  // Table view — client filter + sort over filteredReceipts (date-chronological)
  const tableFiltered = (() => {
    const entries = Object.entries(columnFilters).filter(([, v]) => v);
    if (entries.length === 0) return filteredReceipts;
    return filteredReceipts.filter((r: any) => {
      for (const [k, v] of entries) {
        let val: string;
        if (k === 'itemCount') val = String(r.items?.length ?? '');
        else if (k === 'fileType') val = r.fileType === 'application/pdf' ? 'pdf' : '';
        else val = String(r[k] ?? r[k.replace(/_([a-z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? r[k.replace(/([A-Z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? '');
        if (!val.toLowerCase().includes(String(v).toLowerCase())) return false;
      }
      return true;
    });
  })();
  const tableSorted = (() => {
    if (!tSortBy) return tableFiltered;
    const dir = tSortOrder === 'asc' ? 1 : -1;
    const isDate = tSortBy === 'receipt_date';
    return [...tableFiltered].sort((a: any, b: any) => {
      const avRaw = isDate ? (a.receiptDate ?? '') : (a[tSortBy!] ?? (a as any)[tSortBy!.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())] ?? '');
      const bvRaw = isDate ? (b.receiptDate ?? '') : (b[tSortBy!] ?? (b as any)[tSortBy!.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase())] ?? '');
      if (isDate) {
        const parse = (v: string) => {
          if (!v) return 0;
          const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (m) return new Date(`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`).getTime();
          const t = Date.parse(String(v));
          return isNaN(t) ? 0 : t;
        };
        return (parse(avRaw) - parse(bvRaw)) * dir;
      }
      const av = String(avRaw).toLowerCase();
      const bv = String(bvRaw).toLowerCase();
      if (!isNaN(Number(av)) && !isNaN(Number(bv)) && av && bv) return (Number(av) - Number(bv)) * dir;
      return av.localeCompare(bv) * dir;
    });
  })();
  const tableTotal = tableSorted.length;
  const tablePages = Math.max(1, Math.ceil(tableTotal / tPageSize));
  const tableRows = tableSorted.slice((Math.min(tPage, tablePages) - 1) * tPageSize, Math.min(tPage, tablePages) * tPageSize);
  const handleTableSort = (sb: string | null, o: 'asc' | 'desc') => { setTSortBy(sb); setTSortOrder(o); setTPage(1); };
  const handleTableExport = () => {
    if (tableTotal === 0) return;
    setExportModalOpen(true);
  };
  const confirmTableExport = (filename: string) => {
    setExportModalOpen(false);
    setTableExporting(true);
    try {
      const cols = visibleColumnKeys(userId);
      exportRowsAsCsv(tableSorted, cols, filename);
    } catch (e: any) { alert(e?.message || 'Export failed'); } finally { setTableExporting(false); }
  };
  const handleTableModalSaved = (updated: any) => {
    setTableModalReceipt(updated);
    if (searchResults !== null) setSearchResults(prev => prev ? prev.map((r: any) => r.id === updated.id ? { ...r, ...updated } : r) : prev);
  };
  const handleTableModalDeleted = (id: string) => {
    setTableModalReceipt(null);
    if (searchResults !== null) {
      setSearchResults(prev => prev ? prev.filter((r: any) => r.id !== id) : prev);
      setSearchTotal(t => Math.max(0, t - 1));
    }
  };

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
           <span className="ml-1.5 text-xs font-normal text-gray-400">{searchResults !== null ? searchTotal : filteredReceipts.length}</span>
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

        {/* Search */}
        <div className="flex-shrink-0 px-3 py-2 border-b bg-white">
          <SearchBar
            key={userId || 'receipts-search'}
            onResults={onSearchResults}
            onClear={onSearchClear}
            onQueryChange={setSearchQuery}
            searchKey={searchKey}
            searchFn={(q, limit, offset) => receiptApi.search(q, limit, offset, searchFilters)}
          />
        </div>

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
           {(searchResults !== null ? searchTotal : filteredReceipts.length) === 0
             ? '0'
             : `${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, searchResults !== null ? searchTotal : filteredReceipts.length)}`
           } / {searchResults !== null ? searchTotal : filteredReceipts.length}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => { const np = Math.max(1, page - 1); setPage(np); if (searchResults !== null) loadSearchPage(np); }}
            disabled={clampedPage === 1}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100"
          >‹</button>
          <span className="px-1">{clampedPage}/{totalPages}</span>
          <button
            onClick={() => { const np = Math.min(totalPages, page + 1); setPage(np); if (searchResults !== null) loadSearchPage(np); }}
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

        <div className="ml-auto inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
          <button onClick={() => { setViewMode('table'); localStorage.setItem(VIEW_KEY, 'table'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Table2 className="h-3.5 w-3.5" /> Table</button>
          <button onClick={() => { setViewMode('cards'); localStorage.setItem(VIEW_KEY, 'cards'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'cards' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><LayoutGrid className="h-3.5 w-3.5" /> Cards</button>
        </div>

        <button
          onClick={() => setShowExportModal(true)}
          className="flex-shrink-0 px-3 py-1.5 text-xs sm:text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Export
        </button>
      </div>

      {viewMode === 'table' ? (
        <div className="flex-1 overflow-auto p-4 bg-gray-100">
          <ReceiptsTableView
            userId={userId}
            rows={tableRows}
            total={tableTotal}
            page={Math.min(tPage, tablePages)}
            pageSize={tPageSize}
            onPageChange={(p, s) => { setTPage(p); setTPageSize(s); }}
            sortBy={tSortBy}
            sortOrder={tSortOrder}
            onSortChange={handleTableSort}
            columnFilters={columnFilters}
            onColumnFilter={(k, v) => { setColumnFilters(prev => { const n = { ...prev, [k]: v }; if (!v) delete n[k]; return n; }); setTPage(1); }}
            loading={loading}
            onRowClick={(r: any) => setTableModalReceipt(r)}
            onExport={handleTableExport}
            exporting={tableExporting}
          />
          <ExportNameModal
            open={exportModalOpen}
            count={tableTotal}
            defaultName={defaultExportName('receipts', { dateStart: filters.dateStart, dateEnd: filters.dateEnd, batch: batchParam || undefined }, tableTotal)}
            onConfirm={confirmTableExport}
            onCancel={() => setExportModalOpen(false)}
          />
          {tableModalReceipt && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl lg:max-w-[95vw] xl:max-w-6xl 2xl:max-w-7xl max-h-[92vh] lg:h-[92vh] flex flex-col">
                <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">{tableModalReceipt.supplier || 'Receipt'}</h3>
                    <p className="text-xs text-gray-500 truncate">{tableModalReceipt.receiptDate || ''} · KES {Number(tableModalReceipt.totalAmount || 0).toLocaleString()}</p>
                  </div>
                  <button onClick={() => setTableModalReceipt(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <ReviewPanel userId={userId!} receipt={tableModalReceipt} setIsEditing={() => {}} isAdmin={isAdmin} onSaved={handleTableModalSaved} onDeleted={handleTableModalDeleted} />
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
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
              isAdmin={isAdmin}
              onDeleted={handleDeleted}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to view details
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
};

export default ViewScansPage;
