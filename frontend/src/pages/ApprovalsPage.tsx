// src/pages/ApprovalsPage.tsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { receiptStatusLabel, receiptStatusClass } from '../utils/receiptStatus';
import ReviewPanel from '../components/ReviewPanel';
import SearchBar from '../components/SearchBar';
import ReceiptsTableView from '../components/ReceiptsTableView';
import { Table2, LayoutGrid, ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 25;

/**
 * Admin-only global approval center (cross-tenant).
 *
 * Unlike the old table view (which redirected to the owner's workspace to
 * inspect a receipt), this is a standalone sidebar + detail layout that
 * embeds the same ReviewPanel used by the review page — so the admin can
 * fix a field and Approve/Reject right here without leaving the page.
 */

const ApprovalsPage = () => {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user?.is_admin;

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Search (reuses the indexed search) + client-side filters
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState({ category: '', batch: '' });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [page, setPage] = useState(1);
  const VIEW_KEY = 'scanapp-approvals-view';
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(() =>
    localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'table'
  );
  const [tPage, setTPage] = useState(1);
  const [tPageSize, setTPageSize] = useState(25);
  const [tSortBy, setTSortBy] = useState<string | null>(null);
  const [tSortOrder, setTSortOrder] = useState<'asc' | 'desc'>('desc');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  // Table modal (mirrors cards detail panel capabilities)
  const [tableModalId, setTableModalId] = useState<string | null>(null);
  const [tableModalReceipt, setTableModalReceipt] = useState<any | null>(null);
  // Unsaved-changes confirm when switching receipts mid-edit (modal, no browser confirm)
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data: any = await receiptApi.listPendingApproval();
      setItems(data.items || []);
    } catch (e: any) {
      console.error('Failed to load approvals', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const onSearchResults = (results: any[], t: number) => {
    setSearchResults(results);
    setSearchTotal(t);
    setPage(1);
  };

  const onSearchClear = () => {
    setSearchResults(null);
    setSearchTotal(0);
    setSearchQuery('');
    setPage(1);
    load();
  };

  const searchFilters = {
    category: filters.category || undefined,
    batchTitle: filters.batch || undefined,
  };
  async function loadSearchPage(pageNum: number) {
    if (!searchQuery.trim()) return;
    try {
      const result = await receiptApi.listPendingApproval(
        searchQuery.trim(), PAGE_SIZE, (pageNum - 1) * PAGE_SIZE, searchFilters,
      );
      setSearchResults(result.items || []);
      setSearchTotal(result.total || 0);
    } catch {
      setSearchResults([]);
      setSearchTotal(0);
    }
  }

  // Collapse sidebar when editing; restore on desktop when done
  useEffect(() => {
    if (isEditing) {
      setSidebarOpen(false);
    } else if (window.innerWidth >= 1024) {
      setSidebarOpen(true);
    }
  }, [isEditing]);

  // Auto-select the first pending receipt once the queue loads
  useEffect(() => {
    if (!selectedId && items.length > 0) {
      setSelectedId(items[0].id);
    }
  }, [items, selectedId]);

  // Deep link from the message center: ?receipt=<id> selects that receipt.
  const [searchParams] = useSearchParams();
  const deepLinkId = searchParams.get('receipt');
  useEffect(() => {
    if (deepLinkId && selectedId !== deepLinkId && items.some(r => r.id === deepLinkId)) {
      setSelectedId(deepLinkId);
    }
  }, [deepLinkId, items, selectedId]);

  const selectedRow = searchResults?.find((r: any) => r.id === selectedId)
    || items.find((r: any) => r.id === selectedId)
    || null;

  // Fetch the full receipt (with items + image) cross-tenant when selectio changes
  useEffect(() => {
    if (!selectedRow) {
      setSelectedReceipt(null);
      return;
    }
    let cancelled = false;
    const fetchFull = async () => {
      try {
        const full = await receiptApi.get(selectedRow.id, selectedRow.owner_uid);
        if (!cancelled) setSelectedReceipt(full);
      } catch (e) {
        console.error('Failed to load approval receipt', e);
        if (!cancelled) setSelectedReceipt(null);
      }
    };
    fetchFull();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Table modal fetch (same cross-tenant)
  useEffect(() => {
    if (!tableModalId) { setTableModalReceipt(null); return; }
    const row = (searchResults ?? items).find((r: any) => r.id === tableModalId) as any;
    if (!row) { setTableModalReceipt(null); return; }
    let cancelled = false;
    receiptApi.get(row.id, row.owner_uid).then(full => { if (!cancelled) setTableModalReceipt(full); }).catch(() => { if (!cancelled) setTableModalReceipt(null); });
    return () => { cancelled = true; };
  }, [tableModalId, items, searchResults]);

  const handleSelect = (newId: string) => {
    if (isEditing) {
      setDiscardTarget(newId);
      return;
    }
    setSelectedId(newId);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const confirmDiscardSwitch = () => {
    if (!discardTarget) return;
    setSelectedId(discardTarget);
    if (window.innerWidth < 1024) setSidebarOpen(false);
    setDiscardTarget(null);
  };

  // When a receipt leaves the pending queue (approve/reject/delete), advance
  // the panel and optimistically remove from list without waiting for reload.
  const advancePast = (removedId: string) => {
    setSelectedReceipt(null);
    setItems(prev => prev.filter((r: any) => r.id !== removedId));
    if (searchResults !== null) {
      setSearchResults(prev => prev ? prev.filter((r: any) => r.id !== removedId) : prev);
      setSearchTotal(t => Math.max(0, t - 1));
    }
    const remaining = items.filter((r: any) => r.id !== removedId);
    if (remaining.length > 0) setSelectedId(remaining[0].id);
    else setSelectedId(null);
    load();
  };

  const handleSaved = (updated: any) => {
    if (updated?.status === 'pending_approval') {
      setSelectedReceipt(updated);
      setItems(prev => prev.map((r: any) => r.id === updated.id ? { ...r, ...updated, receipt_date: updated.receiptDate || r.receipt_date } : r));
      if (searchResults !== null) setSearchResults(prev => prev ? prev.map((r: any) => r.id === updated.id ? { ...r, ...updated } : r) : prev);
      load();
    } else {
      advancePast(updated?.id as string);
    }
  };

  const handleDeleted = (id: string) => advancePast(id);
  const handleTableSaved = (updated: any) => {
    setTableModalReceipt(updated);
    setItems(prev => prev.map((r: any) => r.id === updated.id ? { ...r, ...updated, receipt_date: updated.receiptDate || r.receipt_date } : r));
    if (searchResults !== null) setSearchResults(prev => prev ? prev.map((r: any) => r.id === updated.id ? { ...r, ...updated } : r) : prev);
    if (updated?.status !== 'pending_approval') { setTableModalId(null); setTableModalReceipt(null); advancePast(updated.id); }
  };
  const handleTableDeleted = (id: string) => { setTableModalId(null); setTableModalReceipt(null); advancePast(id); };

  // NOTE: all hooks must run on EVERY render — the early returns below make
  // the hook count vary (React #310 "rendered more hooks") if any hook sits
  // after them.
  const sourceRows = searchResults !== null ? searchResults : items;
  const displayTotal = searchResults !== null ? searchTotal : items.length;

  const uniqueCategories = useMemo(
    () => [...new Set(sourceRows.map((r: any) => r.category).filter(Boolean))].sort(),
    [sourceRows],
  );
  const uniqueBatches = useMemo(
    () => [...new Set(sourceRows.map((r: any) => r.batch_title).filter(Boolean))].sort(),
    [sourceRows],
  );

  const filteredRows = useMemo(
    () =>
      sourceRows.filter((r: any) => {
        const catMatch = filters.category ? r.category === filters.category : true;
        const batchMatch = filters.batch ? (r.batch_title || '') === filters.batch : true;
        return catMatch && batchMatch;
      }),
    [sourceRows, filters],
  );

  useEffect(() => { setPage(1); setTPage(1); }, [filters, searchResults]);

  if (!isAdmin) {
    return (
      <div className="p-6 w-full">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">Admins only</h2>
          <p className="text-gray-500 text-sm">You need admin privileges to review approvals.</p>
        </div>
      </div>
    );
  }

  if (loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
          <p className="text-gray-500">Loading…</p>
        </div>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">Nothing to approve</h2>
          <p className="text-gray-500 text-sm">No receipts are awaiting approval.</p>
        </div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil((searchResults !== null ? searchTotal : filteredRows.length) / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = searchResults !== null
    ? filteredRows
    : filteredRows.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  // Table view — client filter + sort over filteredRows (date-aware)
  const tableFiltered = (() => {
    const entries = Object.entries(columnFilters).filter(([, v]) => v);
    if (entries.length === 0) return filteredRows;
    return filteredRows.filter((r: any) => {
      for (const [k, v] of entries) {
        let val: string;
        if (k === 'itemCount') val = String(r.items?.length ?? '');
        else if (k === 'fileType') val = r.fileType === 'application/pdf' ? 'pdf' : '';
        else val = String(r[k] ?? r[k.replace(/([A-Z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? '');
        if (!val.toLowerCase().includes(String(v).toLowerCase())) return false;
      }
      return true;
    });
  })();
  const tableSorted = (() => {
    if (!tSortBy) return tableFiltered;
    const dir = tSortOrder === 'asc' ? 1 : -1;
    const m: Record<string, string> = { receipt_date: 'receipt_date', receiptDate: 'receipt_date', supplier: 'supplier', total_amount: 'total_amount', category: 'category', status: 'status', invoice_number: 'invoice_number', entry_type: 'entry_type', batch_title: 'batch_title', created_at: 'createdAt', location: 'location', kra_pin: 'kraPin', kraPin: 'kraPin', buyer_kra_pin: 'buyerKraPin', buyerKraPin: 'buyerKraPin', cu_invoice: 'cuInvoice', cuInvoice: 'cuInvoice', file_type: 'fileType', fileType: 'fileType' };
    const k = m[tSortBy] || tSortBy;
    const isDateKey = k === 'receipt_date';
    return [...tableFiltered].sort((a: any, b: any) => {
      const avRaw = a[k] ?? '';
      const bvRaw = b[k] ?? '';
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

  /* ── Sidebar contents (shared between desktop inline & mobile overlay) ── */
  const SidebarBody = (
    <>
      {/* Sidebar header */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b bg-gray-50">
        <span className="text-sm font-semibold text-gray-700 truncate">
          Pending Approvals
          <span className="ml-1.5 text-xs font-normal text-gray-400">{displayTotal}</span>
        </span>
        <button
          onClick={() => setSidebarOpen(false)}
          className="p-1 rounded hover:bg-gray-200 text-gray-500"
          title="Collapse"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* Indexed search + filters */}
      <div className="flex-shrink-0 px-3 py-2 border-b bg-white space-y-2">
        <SearchBar
          key={user?.uid || 'approvals-search'}
          placeholder="Search pending approvals…"
          onResults={onSearchResults}
          onClear={onSearchClear}
          onQueryChange={setSearchQuery}
          searchKey={JSON.stringify(filters)}
          searchFn={(q, limit, offset) => receiptApi.listPendingApproval(q, limit, offset, searchFilters)}
        />
        <div className="flex gap-2">
          <select value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white flex-1 min-w-0">
            <option value="">All Categories</option>
            {uniqueCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.batch} onChange={e => setFilters(f => ({ ...f, batch: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white flex-1 min-w-0">
            <option value="">All Batches</option>
            {uniqueBatches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
          {(Object.values(filters).some(Boolean) || searchResults !== null) && (
            <button
              onClick={() => { setFilters({ category: '', batch: '' }); onSearchClear(); }}
              className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 flex-shrink-0"
            >Clear</button>
          )}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y">
        {pageItems.length === 0 && (
          <p className="p-4 text-sm text-gray-400">No receipts match.</p>
        )}
        {pageItems.map((row: any) => (
          <div
            key={row.id}
            onClick={() => handleSelect(row.id)}
            className={`px-3 py-3 cursor-pointer transition-colors border-l-4 ${
              selectedId === row.id
                ? 'bg-blue-50 border-blue-500'
                : 'border-transparent hover:bg-gray-50'
            }`}
          >
            <div className="flex gap-2.5">
              {row.imageUrl ? (
                <img
                  src={`/api/images/cached?url=${encodeURIComponent(row.imageUrl)}&thumb=1`}
                  alt=""
                  className="w-10 h-10 rounded object-cover border bg-gray-50 flex-shrink-0 mt-0.5"
                />
              ) : (
                <div className="w-10 h-10 rounded bg-gray-100 border flex-shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{row.supplier || 'Untitled'}</div>
                <div className="text-xs text-gray-400 mt-0.5 truncate">
                  {row.receipt_date || '—'} · {row.owner_display_name || row.owner_email || row.owner_uid}
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-gray-600 font-medium">KES {Number(row.total_amount || 0).toLocaleString()}</span>
                  <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${receiptStatusClass(row.status)}`}>
                    {receiptStatusLabel(row.status)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>
          {`${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, searchResults !== null ? searchTotal : filteredRows.length)}`}
          {' '}/ {searchResults !== null ? searchTotal : filteredRows.length}
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
        <h1 className="font-semibold text-sm text-gray-700">Pending Approvals</h1>
        <span className="text-xs text-gray-400">{displayTotal} across all users</span>
        <div className="ml-auto inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
          <button onClick={() => { setViewMode('table'); localStorage.setItem(VIEW_KEY, 'table'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Table2 className="h-3.5 w-3.5" /> Table</button>
          <button onClick={() => { setViewMode('cards'); localStorage.setItem(VIEW_KEY, 'cards'); }} className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium ${viewMode === 'cards' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><LayoutGrid className="h-3.5 w-3.5" /> Cards</button>
        </div>
      </div>

      {viewMode === 'table' ? (
        <div className="flex-1 overflow-auto p-4 bg-gray-100">
          <ReceiptsTableView
            userId={user?.uid || null}
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
            onRowClick={(r: any) => setTableModalId(r.id)}
          />
          {tableModalId && tableModalReceipt && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
              <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl lg:max-w-[95vw] xl:max-w-6xl 2xl:max-w-7xl max-h-[92vh] lg:h-[92vh] flex flex-col">
                <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
                  <div className="min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">{tableModalReceipt.supplier || (tableModalReceipt as any).supplier || 'Receipt'}</h3>
                    <p className="text-xs text-gray-500 truncate">{tableModalReceipt.receiptDate || (tableModalReceipt as any).receipt_date || ''} · KES {Number(tableModalReceipt.totalAmount || (tableModalReceipt as any).total_amount || 0).toLocaleString()}</p>
                  </div>
                  <button onClick={() => { setTableModalId(null); setTableModalReceipt(null); }} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {(() => {
                    const row = (searchResults ?? items).find((r: any) => r.id === tableModalId) as any;
                    const owner = row?.owner_uid || tableModalReceipt.userId || '';
                    return <ReviewPanel userId={owner} receipt={tableModalReceipt} setIsEditing={() => {}} isAdmin={isAdmin} useStore={false} onSaved={handleTableSaved} onDeleted={handleTableDeleted} />;
                  })()}
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
          {selectedId && selectedReceipt && selectedRow ? (
            <ReviewPanel
              userId={selectedRow.owner_uid}
              receipt={selectedReceipt}
              setIsEditing={setIsEditing}
              isAdmin={isAdmin}
              onSaved={handleSaved}
              onDeleted={handleDeleted}
              useStore={false}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm space-y-2">
              {selectedId ? (
                <>
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent" />
                  <span>Loading receipt…</span>
                </>
              ) : (
                <span>Select a receipt to review</span>
              )}
            </div>
          )}
        </div>
      </div>
      )}

      {/* ── Unsaved-changes modal when switching receipts mid-edit ── */}
      {discardTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Unsaved Changes</h3>
            <p className="text-sm text-gray-600">
              You have unsaved edits. Discard them and switch to another receipt?
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setDiscardTarget(null)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={confirmDiscardSwitch}
                className="px-4 py-2 text-white bg-red-600 rounded hover:bg-red-700"
              >
                Discard & Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApprovalsPage;
