// src/pages/ViewScansPage.tsx
import { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Calendar, Clock, Search, X } from 'lucide-react';
import { useReceiptStore } from '../stores/receiptStore';
import { receiptApi } from '../services/api';
import ReviewPanel from '../components/ReviewPanel';
import type { ReceiptData } from '../types/gemini';

const PAGE_SIZE = 25;

const isMissing = (val: any) => !val || val === 'N/A' || val.toString().trim() === '';
const isComplete = (r: any) =>
  !isMissing(r.receiptDate) && !isMissing(r.totalAmount) &&
  !isMissing(r.supplier) && !isMissing(r.category) && r.status === 'processed';

const ViewScansPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const { items: storeReceipts, loading: storeLoading, load } = useReceiptStore();
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  // ── State ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [page, setPage] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [sortBy, setSortBy] = useState<'date' | 'scanned'>('scanned');

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);

  // ── Load store ──
  useEffect(() => { if (userId) load(userId); }, [userId, load]);

  // ── Debounced search ──
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!searchQuery.trim()) {
      setSearchResults(null);
      setSearchTotal(0);
      setPage(1);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      if (!searchQuery.trim()) return;
      setSearching(true);
      try {
        const result = await receiptApi.search(searchQuery, PAGE_SIZE, 0);
        setSearchResults(result.results || []);
        setSearchTotal(result.total || 0);
        setPage(1);
      } catch (e) { /* ignore */ }
      finally { setSearching(false); }
    }, 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery]);

  // ── Load more search results ──
  const loadSearchPage = async (pageNum: number) => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const offset = (pageNum - 1) * PAGE_SIZE;
      const result = await receiptApi.search(searchQuery, PAGE_SIZE, offset);
      setSearchResults(result.results || []);
      setSearchTotal(result.total || 0);
    } catch (e) { /* ignore */ }
    finally { setSearching(false); }
  };

  // ── Collapse sidebar when editing ──
  useEffect(() => {
    if (isEditing) setSidebarOpen(false);
    else if (window.innerWidth >= 1024) setSidebarOpen(true);
  }, [isEditing]);

  // ── Auto-select first item ──
  useEffect(() => {
    if (!selectedId && displayReceipts.length > 0) setSelectedId(displayReceipts[0].id);
  }, [displayReceipts, selectedId]);

  const handleSelect = (id: string) => {
    if (isEditing && !confirm('Discard unsaved changes?')) return;
    setSelectedId(id);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // ── Data source ──
  const isSearchMode = searchResults !== null;
  const rawReceipts: ReceiptData[] = isSearchMode ? searchResults : (storeReceipts as ReceiptData[]);
  const total = isSearchMode ? searchTotal : storeReceipts.length;

  const receipts = useMemo(() => {
    let list = [...rawReceipts];
    if (isSearchMode) return list; // server-sorted
    if (sortBy === 'date') list.sort((a, b) => (b.receiptDate || '').localeCompare(a.receiptDate || ''));
    else list.sort((a, b) => new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime());
    return list;
  }, [rawReceipts, sortBy, isSearchMode]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageReceipts = receipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected = receipts.find(r => r.id === selectedId);
  const displayReceipts = receipts;

  const goToPage = (p: number) => {
    setPage(p);
    if (isSearchMode) loadSearchPage(p);
  };

  // ── Loading ──
  if (storeLoading && !isSearchMode && storeReceipts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-[calc(100vh-4rem)] bg-gray-100">
      {/* ── Top bar ── */}
      <div className="flex-shrink-0 flex items-center gap-3 px-3 py-2 bg-white border-b shadow-sm z-10">
        <button onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600" title="Toggle sidebar">
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input type="text" value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search receipts, items, invoices, pins..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none bg-white" />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <span className="text-sm text-gray-500 flex-shrink-0 whitespace-nowrap">
          {searching ? <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin align-middle mr-1" /> : null}
          {isSearchMode ? `${searchTotal} match${searchTotal !== 1 ? 'es' : ''}` : `${storeReceipts.length} receipt${storeReceipts.length !== 1 ? 's' : ''}`}
        </span>

        {/* Sort (non-search mode) */}
        {!isSearchMode && (
          <div className="hidden sm:flex items-center gap-1 ml-auto">
            <button onClick={() => setSortBy('scanned')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${sortBy === 'scanned' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}>
              <Clock className="h-3 w-3" /> Scanned
            </button>
            <button onClick={() => setSortBy('date')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${sortBy === 'date' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}>
              <Calendar className="h-3 w-3" /> Date
            </button>
          </div>
        )}
      </div>

      {/* ── Main body ── */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Desktop sidebar */}
        <div className={`hidden lg:flex flex-col flex-shrink-0 bg-white border-r transition-[width] duration-200 overflow-hidden ${sidebarOpen ? 'w-64 xl:w-72' : 'w-0'}`}>
          {/* Receipt list */}
          <div className="flex-1 overflow-y-auto divide-y">
            {pageReceipts.length === 0 ? (
              <p className="p-4 text-sm text-gray-400">{isSearchMode ? 'No results' : 'No receipts'}</p>
            ) : pageReceipts.map(receipt => (
              <div key={receipt.id}
                onClick={() => handleSelect(receipt.id)}
                className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
                  selectedId === receipt.id ? 'bg-blue-50 border-blue-500' : 'border-transparent hover:bg-gray-50'
                }`}>
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-sm truncate text-gray-900">{receipt.supplier}</span>
                  <span className={`shrink-0 w-2 h-2 rounded-full ${isComplete(receipt) ? 'bg-green-500' : 'bg-red-500'}`}
                    title={isComplete(receipt) ? 'Processed' : 'Needs review'} />
                </div>
                <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                  <Calendar className="h-3 w-3 shrink-0" /><span>{receipt.receiptDate}</span>
                </div>
                <div className="text-sm text-blue-600 font-bold mt-1.5">KES {Number(receipt.totalAmount).toLocaleString()}</div>
                {/* Search relevance indicator */}
                {isSearchMode && (receipt as any)._search_rank > 0.05 && (
                  <div className="text-[10px] text-gray-400 mt-0.5">{Math.round((receipt as any)._search_rank * 100)}% match</div>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
            <span>{total === 0 ? '0' : `${Math.min(total, (clampedPage-1)*PAGE_SIZE+1)}–${Math.min(clampedPage*PAGE_SIZE, total)}`} / {total}</span>
            <div className="flex gap-1">
              <button onClick={() => goToPage(Math.max(1, page - 1))} disabled={clampedPage === 1}
                className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">‹</button>
              <span className="px-1">{clampedPage}/{totalPages}</span>
              <button onClick={() => goToPage(Math.min(totalPages, page + 1))} disabled={clampedPage >= totalPages}
                className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">›</button>
            </div>
          </div>
        </div>

        {/* Mobile overlay sidebar */}
        <>
          <div className={`lg:hidden fixed top-14 bottom-0 left-0 z-50 w-72 flex flex-col bg-white shadow-2xl transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            <div className="flex-1 overflow-y-auto divide-y">
              {pageReceipts.map(receipt => (
                <div key={receipt.id}
                  onClick={() => handleSelect(receipt.id)}
                  className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
                    selectedId === receipt.id ? 'bg-blue-50 border-blue-500' : 'border-transparent hover:bg-gray-50'
                  }`}>
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-sm truncate text-gray-900">{receipt.supplier}</span>
                    <span className={`shrink-0 w-2 h-2 rounded-full ${isComplete(receipt) ? 'bg-green-500' : 'bg-red-500'}`} />
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-gray-500 mt-1">
                    <Calendar className="h-3 w-3 shrink-0" /><span>{receipt.receiptDate}</span>
                  </div>
                  <div className="text-sm text-blue-600 font-bold mt-1.5">KES {Number(receipt.totalAmount).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
              <span>{total === 0 ? '0' : `${Math.min(total, (clampedPage-1)*PAGE_SIZE+1)}–${Math.min(clampedPage*PAGE_SIZE, total)}`}</span>
              <div className="flex gap-1">
                <button onClick={() => goToPage(Math.max(1, page - 1))} disabled={clampedPage === 1}
                  className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">‹</button>
                <button onClick={() => goToPage(Math.min(totalPages, page + 1))} disabled={clampedPage >= totalPages}
                  className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">›</button>
              </div>
            </div>
          </div>
          {sidebarOpen && <div className="lg:hidden fixed inset-0 top-14 bg-black/40 z-40" onClick={() => setSidebarOpen(false)} />}
        </>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <ReviewPanel userId={userId!} receipt={selected as ReceiptData} setIsEditing={setIsEditing} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to view
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ViewScansPage;
