// src/pages/ReviewPage.tsx
import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useReceiptStore } from '../stores/receiptStore';
import { useAuthStore } from '../stores/authStore';
import { receiptApi } from '../services/api';
import type { ReceiptData } from '../types/gemini';
import ReviewPanel from '../components/ReviewPanel';
import SearchBar from '../components/SearchBar';
import ReceiptsTableView from '../components/ReceiptsTableView';
import { Table2, LayoutGrid, ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 25;

const ReviewPage = ({ userId }: { userId: string | null }) => {
  const { items: allReceipts, loading, load } = useReceiptStore();
  const { user } = useAuthStore();
  const isAdmin = !!user?.is_admin;

  // Search
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchTotal, setSearchTotal] = useState(0);

  const receipts = useMemo(() => {
    if (searchResults !== null) {
      return searchResults.filter((r: any) => r.status === 'needs_review') as ReceiptData[];
    }
    return allReceipts.filter(r => r.status === 'needs_review') as ReceiptData[];
  }, [allReceipts, searchResults]);

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
      const result = await receiptApi.search(searchQuery.trim(), PAGE_SIZE, (pageNum - 1) * PAGE_SIZE, {
        status: 'needs_review',
      });
      setSearchResults(result.results || []);
      setSearchTotal(result.total || 0);
    } catch {
      setSearchResults([]);
      setSearchTotal(0);
    }
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<ReceiptData | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [page, setPage] = useState(1);
  const VIEW_KEY = 'scanapp-review-view';
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() =>
    localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  );
  const [tPage, setTPage] = useState(1);
  const [tPageSize, setTPageSize] = useState(25);
  const [tSortBy, setTSortBy] = useState<string | null>(null);
  const [tSortOrder, setTSortOrder] = useState<'asc' | 'desc'>('desc');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!userId) return;
    load(userId);
  }, [userId, load]);

  useEffect(() => {
    setSearchResults(null);
    setSearchTotal(0);
    setSearchQuery('');
    setPage(1);
  }, [userId]);

  // Collapse sidebar when editing; restore on desktop when done
  useEffect(() => {
    if (isEditing) {
      setSidebarOpen(false);
    } else if (window.innerWidth >= 1024) {
      setSidebarOpen(true);
    }
  }, [isEditing]);

  useEffect(() => {
    if (!selectedId && receipts.length > 0) {
      setSelectedId(receipts[0].id);
    }
  }, [receipts, selectedId]);

  // Deep link from the message center: ?receipt=<id> selects that receipt.
  const [searchParams] = useSearchParams();
  const deepLinkId = searchParams.get('receipt');
  useEffect(() => {
    if (deepLinkId && selectedId !== deepLinkId && receipts.some(r => r.id === deepLinkId)) {
      setSelectedId(deepLinkId);
    }
  }, [deepLinkId, receipts, selectedId]);

  const handleSelect = (newId: string) => {
    if (isEditing) {
      if (!confirm('You have unsaved changes. Do you want to discard them and switch receipts?')) return;
    }
    setSelectedId(newId);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // If a receipt leaves the needs_review view (status change or delete),
  // advance the panel to the next pending receipt so it never dangles on
  // stale/blank data.
  const advancePast = (removedId: string) => {
    setSelectedReceipt(null);
    const remaining = receipts.filter(r => r.id !== removedId && r.status === 'needs_review');
    if (remaining.length > 0) setSelectedId(remaining[0].id);
    else setSelectedId(null);
  };

  // After a save, show the saved data (still editable) if the receipt remains
  // in the needs_review view; otherwise advance to the next pending receipt.
  const handleSaved = (updated: any) => {
    if (updated?.status === 'needs_review') {
      setSelectedReceipt(updated);
    } else {
      advancePast(updated?.id as string);
    }
  };

  const handleDeleted = (id: string) => advancePast(id);

  // Fetch full receipt with items from API when selection changes
  useEffect(() => {
    if (!selectedId) return;
    const fetchFull = async () => {
      try {
        const full = await receiptApi.get(selectedId);
        setSelectedReceipt(full);
      } catch (e) { /* ignore */ }
    };
    fetchFull();
  }, [selectedId]);

  const totalPages = Math.max(1, Math.ceil((searchResults !== null ? searchTotal : receipts.length) / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageReceipts = searchResults !== null
    ? receipts
    : receipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected = selectedReceipt || receipts.find(r => r.id === selectedId) || null;

  const tableFiltered = (() => {
    const entries = Object.entries(columnFilters).filter(([, v]) => v);
    if (entries.length === 0) return receipts;
    return receipts.filter((r: any) => {
      for (const [k, v] of entries) {
        let val: string;
        if (k === 'itemCount') val = String(r.items?.length ?? '');
        else if (k === 'fileType') val = r.fileType === 'application/pdf' ? 'pdf' : '';
        else val = String((r as any)[k] ?? '');
        if (!val.toLowerCase().includes(String(v).toLowerCase())) return false;
      }
      return true;
    });
  })();
  const tableSorted = (() => {
    if (!tSortBy) return tableFiltered;
    const dir = tSortOrder === 'asc' ? 1 : -1;
    const m: Record<string, string> = { receipt_date: 'receiptDate', supplier: 'supplier', total_amount: 'totalAmount', category: 'category', status: 'status', invoice_number: 'invoiceNumber', batch_title: 'batchTitle', location: 'location', kra_pin: 'kraPin', kraPin: 'kraPin', buyer_kra_pin: 'buyerKraPin', buyerKraPin: 'buyerKraPin', cu_invoice: 'cuInvoice', cuInvoice: 'cuInvoice', file_type: 'fileType', fileType: 'fileType' };
    const k = m[tSortBy] || tSortBy;
    const isDateKey = k === 'receiptDate';
    return [...tableFiltered].sort((a: any, b: any) => {
      const avRaw = (a as any)[k] ?? '';
      const bvRaw = (b as any)[k] ?? '';
      if (isDateKey) {
        const parse = (v: string) => {
          if (!v) return 0;
          const mm = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
          if (mm) return new Date(`${mm[3]}-${mm[1].padStart(2,'0')}-${mm[2].padStart(2,'0')}`).getTime();
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

  if (loading && receipts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
          <p className="text-gray-500">Loading…</p>
        </div>
      </div>
    );
  }

  if (!loading && receipts.length === 0 && searchResults === null) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">Nothing to Review</h2>
          <p className="text-gray-500 text-sm">All receipts have been processed.</p>
        </div>
      </div>
    );
  }

  /* ── Sidebar contents (shared between desktop inline & mobile overlay) ── */
  const SidebarBody = (
    <>
      {/* Sidebar header */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b bg-gray-50">
        <span className="text-sm font-semibold text-gray-700 truncate">
           Needs Review
           <span className="ml-1.5 text-xs font-normal text-gray-400">{searchResults !== null ? searchTotal : allReceipts.filter(r => r.status === 'needs_review').length}</span>
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
          key={userId || 'review-search'}
            onResults={onSearchResults}
            onClear={onSearchClear}
            onQueryChange={setSearchQuery}
            searchFn={(q, limit, offset) => receiptApi.search(q, limit, offset, { status: 'needs_review' })}
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y">
        {searchResults !== null && receipts.length === 0 ? (
          <div className="flex items-center justify-center h-full py-12 px-4 text-sm text-gray-400 text-center">
            No matches found
          </div>
        ) : (
          pageReceipts.map(receipt => (
            <div
              key={receipt.id}
              onClick={() => handleSelect(receipt.id)}
              className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
                selectedId === receipt.id
                  ? 'bg-blue-50 border-blue-500'
                  : 'border-transparent hover:bg-gray-50'
              }`}
            >
              <div className="font-medium text-sm truncate">{receipt.supplier}</div>
              <div className="text-xs text-gray-400 mt-0.5">{receipt.receiptDate}</div>
              <div className="text-xs text-gray-600 font-medium">{receipt.totalAmount} KES</div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>
           {`${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, searchResults !== null ? searchTotal : receipts.length)}`}
           {' '}/ {searchResults !== null ? searchTotal : receipts.length}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => { const next = Math.max(1, page - 1); setPage(next); if (searchResults !== null) loadSearchPage(next); }}
            disabled={clampedPage === 1}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100"
          >‹</button>
          <span className="px-1">{clampedPage}/{totalPages}</span>
          <button
            onClick={() => { const next = Math.min(totalPages, page + 1); setPage(next); if (searchResults !== null) loadSearchPage(next); }}
            disabled={clampedPage >= totalPages}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100"
          >›</button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col w-full h-[calc(100vh-4rem)] bg-gray-100">

      {/* ── Top bar with sidebar toggle + view toggle ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
        <button
          onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600"
          title={sidebarOpen ? 'Collapse list' : 'Expand list'}
        >
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="font-semibold text-sm text-gray-700">Needs Review</span>
        <div className="ml-auto inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
          <button onClick={() => { setViewMode('table'); localStorage.setItem(VIEW_KEY, 'table'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Table2 className="h-3.5 w-3.5" /> Table</button>
          <button onClick={() => { setViewMode('cards'); localStorage.setItem(VIEW_KEY, 'cards'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'cards' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><LayoutGrid className="h-3.5 w-3.5" /> Cards</button>
        </div>
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
            onSortChange={(sb, o) => { setTSortBy(sb); setTSortOrder(o); setTPage(1); }}
            columnFilters={columnFilters}
            onColumnFilter={(k, v) => { setColumnFilters(prev => { const n = { ...prev, [k]: v }; if (!v) delete n[k]; return n; }); setTPage(1); }}
            loading={loading}
            onRowClick={(r: any) => setSelectedId(r.id)}
          />
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
            <ReviewPanel userId={userId!} receipt={selected} setIsEditing={setIsEditing} isAdmin={isAdmin} onSaved={handleSaved} onDeleted={handleDeleted} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to review
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
};

export default ReviewPage;
