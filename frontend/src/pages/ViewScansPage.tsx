// src/pages/ViewScansPage.tsx
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Calendar, Clock, Search, X } from 'lucide-react';
import { useReceiptStore } from '../stores/receiptStore';
import { receiptApi } from '../services/api';
import ReviewPanel from '../components/ReviewPanel';
import type { ReceiptData } from '../types/gemini';

const PAGE_SIZE = 25;

const isMissing = (val: any) => !val || val === 'N/A' || val.toString().trim() === '';
const isComplete = (receipt: any) =>
  !isMissing(receipt.receiptDate) && !isMissing(receipt.totalAmount) &&
  !isMissing(receipt.supplier) && !isMissing(receipt.category) &&
  receipt.status === 'processed';

const ViewScansPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { items: storeReceipts, loading: storeLoading, load } = useReceiptStore();

  const queryFromUrl = new URLSearchParams(location.search).get('q') || '';

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState(queryFromUrl);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);

  // ── View state ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [page, setPage] = useState(1);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [sortBy, setSortBy] = useState<'date' | 'scanned' | 'rank'>('scanned');

  // ── Load store on mount ──
  useEffect(() => { if (userId) load(userId); }, [userId, load]);

  // ── Live search with debounce ──
  useEffect(() => {
    if (!userId || !searchQuery.trim()) {
      setIsSearchMode(false);
      setSearchResults([]);
      setSearchTotal(0);
      setSortBy('scanned');
      return;
    }

    const timer = setTimeout(async () => {
      setSearching(true);
      setIsSearchMode(true);
      setPage(1);
      setSortBy('rank');
      try {
        const result = await receiptApi.search(searchQuery, PAGE_SIZE, 0);
        setSearchResults(result.results || []);
        setSearchTotal(result.total || 0);
      } catch (e) {
        console.error('Search failed:', e);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery, userId]);

  // ── Paginated search ──
  const loadSearchPage = useCallback(async (pageNum: number) => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const offset = (pageNum - 1) * PAGE_SIZE;
      const result = await receiptApi.search(searchQuery, PAGE_SIZE, offset);
      setSearchResults(result.results || []);
      setSearchTotal(result.total || 0);
    } catch (e) { /* ignore */ }
    finally { setSearching(false); }
  }, [searchQuery]);

  // ── Clear search ──
  const clearSearch = () => {
    setSearchQuery('');
    setIsSearchMode(false);
    setSearchResults([]);
    setSearchTotal(0);
    setPage(1);
    setSortBy('scanned');
  };

  // ── Sidebar collapse ──
  useEffect(() => {
    if (isEditing) setSidebarOpen(false);
    else if (window.innerWidth >= 1024) setSidebarOpen(true);
  }, [isEditing]);

  useEffect(() => {
    if (!selectedId && displayReceipts.length > 0) setSelectedId(displayReceipts[0].id);
  }, [displayReceipts, selectedId]);

  const handleSelect = (id: string) => {
    if (isEditing && !confirm('Discard unsaved changes?')) return;
    setSelectedId(id);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  // ── Data source ──
  const receipts: ReceiptData[] = isSearchMode
    ? searchResults
    : storeReceipts as ReceiptData[];

  const filteredReceipts = useMemo(() => {
    let result = receipts.filter(r => {
      if (isSearchMode) return true;
      return true; // Store already filtered server-side
    });

    if (sortBy === 'date') {
      result = [...result].sort((a, b) => (b.receiptDate || '').localeCompare(a.receiptDate || ''));
    } else if (sortBy === 'scanned') {
      result = [...result].sort((a, b) =>
        new Date(b.scannedAt || 0).getTime() - new Date(a.scannedAt || 0).getTime()
      );
    }
    // 'rank' sort is handled server-side for search

    return result;
  }, [receipts, sortBy, isSearchMode]);

  const total = isSearchMode ? searchTotal : storeReceipts.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageReceipts = filteredReceipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected = receipts.find(r => r.id === selectedId);
  const displayReceipts = filteredReceipts;

  // ── Page navigation ──
  const goToPage = (newPage: number) => {
    setPage(newPage);
    if (isSearchMode) loadSearchPage(newPage);
  };

  // ── Loading ──
  if (storeLoading && !isSearchMode && storeReceipts.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  const SidebarBody = (
    <>
      {/* ── Search bar ── */}
      <div className="flex-shrink-0 px-3 py-2 border-b bg-white">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search receipts, items, invoices..."
            className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          {searchQuery && (
            <button onClick={clearSearch} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {isSearchMode && (
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-xs text-gray-500">
              {searchTotal} match{searchTotal !== 1 ? 'es' : ''}
              {searching && <span className="ml-1 inline-block animate-spin h-3 w-3 border border-blue-500 border-t-transparent rounded-full align-middle" />}
            </span>
            <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wider">Ranked</span>
          </div>
        )}
      </div>

      {/* ── Sort controls ── */}
      <div className="flex-shrink-0 px-3 py-1.5 flex items-center gap-2 border-b bg-gray-50">
        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Sort:</span>
        {!isSearchMode && (
          <>
            <button onClick={() => setSortBy('scanned')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                sortBy === 'scanned' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200' : 'text-gray-500 hover:bg-gray-100'
              }`}>
              <Clock className="h-3 w-3" /> Scanned
            </button>
            <button onClick={() => setSortBy('date')}
              className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                sortBy === 'date' ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-200' : 'text-gray-500 hover:bg-gray-100'
              }`}>
              <Calendar className="h-3 w-3" /> Date
            </button>
          </>
        )}
        {isSearchMode && (
          <span className="text-[10px] font-medium text-blue-600">Relevance</span>
        )}
      </div>

      {/* ── Receipt list ── */}
      <div className="flex-1 overflow-y-auto divide-y bg-white">
        {pageReceipts.length === 0 ? (
          <p className="p-4 text-sm text-gray-400">
            {isSearchMode ? `No results for "${searchQuery}"` : 'No receipts match your filters.'}
          </p>
        ) : pageReceipts.map(receipt => (
          <div key={receipt.id} onClick={() => handleSelect(receipt.id)}
            className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
              selectedId === receipt.id ? 'bg-blue-50 border-blue-500' : 'border-transparent hover:bg-gray-50'
            }`}>
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-sm truncate text-gray-900">{receipt.supplier}</span>
              <span className={`shrink-0 w-2 h-2 rounded-full ${isComplete(receipt) ? 'bg-green-500' : 'bg-red-500'}`}
                title={isComplete(receipt) ? 'Processed' : 'Needs review'} />
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
            {/* Search highlights */}
            {isSearchMode && (receipt as any)._search_rank > 0.05 && (
              <div className="mt-1 text-[10px] text-gray-400">
                {((receipt as any)._search_rank * 100).toFixed(0)}% match
                {(receipt as any)._item_names ? ` · ${(receipt as any)._item_names.slice(0, 60)}` : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── Pagination ── */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>{total === 0 ? '0' : `${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, total)}`} / {total}</span>
        <div className="flex gap-1">
          <button onClick={() => goToPage(Math.max(1, page - 1))} disabled={clampedPage === 1}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">‹</button>
          <span className="px-1">{clampedPage}/{totalPages}</span>
          <button onClick={() => goToPage(Math.min(totalPages, page + 1))} disabled={clampedPage >= totalPages}
            className="px-2 py-0.5 border rounded disabled:opacity-30 hover:bg-gray-100">›</button>
        </div>
      </div>
    </>
  );

  return (
    <div className="flex flex-col w-full h-[calc(100vh-4rem)] bg-gray-100">
      {/* ── Top bar ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
        <button onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600"
          title={sidebarOpen ? 'Collapse list' : 'Expand list'}>
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="font-semibold text-sm text-gray-700">
          {isSearchMode ? `Search: "${searchQuery}"` : 'All Receipts'}
        </span>
        <span className="text-xs text-gray-400 flex-shrink-0">{total} receipt{total !== 1 ? 's' : ''}</span>
      </div>

      {/* ── Main body ── */}
      <div className="flex flex-1 overflow-hidden relative">
        <div className={`hidden lg:flex flex-col flex-shrink-0 bg-white border-r transition-[width] duration-200 overflow-hidden ${sidebarOpen ? 'w-64 xl:w-72' : 'w-0'}`}>
          {SidebarBody}
        </div>

        {/* Mobile overlay sidebar */}
        <>
          <div className={`lg:hidden fixed top-16 bottom-0 left-0 z-50 w-72 flex flex-col bg-white shadow-2xl transition-transform duration-200 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
            {SidebarBody}
          </div>
          {sidebarOpen && <div className="lg:hidden fixed inset-0 top-16 bg-black/40 z-40" onClick={() => setSidebarOpen(false)} />}
        </>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <ReviewPanel userId={userId!} receipt={selected as ReceiptData} setIsEditing={setIsEditing} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">Select a receipt to view</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ViewScansPage;
