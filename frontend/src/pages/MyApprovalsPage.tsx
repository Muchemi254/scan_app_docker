// src/pages/MyApprovalsPage.tsx
import { useState, useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useScopeStore } from '../stores/scopeStore';
import {
  receiptStatusLabel,
  receiptStatusClass,
} from '../utils/receiptStatus';
import ReviewPanel from '../components/ReviewPanel';
import SearchBar from '../components/SearchBar';
import ReceiptsTableView, { cellValue, isBlankCellValue } from '../components/ReceiptsTableView';
import ExportNameModal from '../components/ExportNameModal';
import { exportRowsAsCsv, visibleColumnKeys, defaultExportName } from '../utils/exportTableCsv';
import { ChevronDown, ChevronRight, Table2, LayoutGrid } from 'lucide-react';

type Tab = 'pending' | 'approved' | 'rejected';

/**
 * User-facing document pipeline page.
 *
 * - Pending Approval: receipts awaiting an admin decision (Recall → back to
 *   review for editing, or View).
 * - Approved: finalized receipts — read-only, cannot be re-edited.
 * - Rejected: receipts the admin sent back with a reason (latest admin
 *   decision was a rejection) — View to fix and resubmit.
 *
 * Receipts are grouped by batch, searchable through the existing indexed
 * search, and opened inline in a review modal guarded so no admin-only
 * actions (approve/reject) leak into the user view.
 */
const MyApprovalsPage = () => {
  const user = useAuthStore((s) => s.user);
  const selfUid = user?.uid;
  const activeUid = useScopeStore((s) => s.activeUid);
  const isAdmin = !!user?.is_admin;

  // Operate on the admin's real account OR the selected scope for non-admin use.
  const effectiveUid = activeUid || selfUid;

  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<any[]>([]);
  const [approved, setApproved] = useState<any[]>([]);
  const [rejected, setRejected] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallTarget, setRecallTarget] = useState<any | null>(null);

  // Indexed search (reused from the receipt search endpoint)
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  // Client-side filters (same pattern as the main receipts list)
  const [filters, setFilters] = useState({
    category: '', supplier: '', dateStart: '', dateEnd: '',
  });

  // View modal — shows the shared ReviewPanel with admin actions disabled
  const [viewTarget, setViewTarget] = useState<any | null>(null);

  // View mode toggle — table (default) vs grouped cards
  const VIEW_KEY = 'scanapp-myapprovals-view';
  const [viewMode, setViewMode] = useState<'table' | 'grouped'>(() =>
    localStorage.getItem(VIEW_KEY) === 'grouped' ? 'grouped' : 'table'
  );
  const [tablePage, setTablePage] = useState(1);
  const [tablePageSize, setTablePageSize] = useState(25);
  const [tableSortBy, setTableSortBy] = useState<string | null>(null);
  const [tableSortOrder, setTableSortOrder] = useState<'asc' | 'desc'>('desc');
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);

  // Collapsible batch groups (default collapsed so the list stays short)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!effectiveUid) return;
    setLoading(true);
    try {
      const [p, a, r] = await Promise.all([
        receiptApi.list(0, 1000, { status: 'pending_approval' }),
        receiptApi.list(0, 1000, { status: 'processed' }),
        receiptApi.list(0, 1000, { rejected: true }),
      ]);
      setItems(p.items || []);
      setApproved(a.items || []);
      setRejected(r.items || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [effectiveUid]);

  useEffect(() => {
    load();
  }, [load]);

  // Deep link from the message center: ?receipt=<id> opens that receipt's modal.
  const [searchParams] = useSearchParams();
  const deepLinkId = searchParams.get('receipt');
  useEffect(() => {
    if (!deepLinkId || viewTarget) return;
    const found = [...items, ...approved, ...rejected].find(r => r.id === deepLinkId);
    if (found) setViewTarget(found);
  }, [deepLinkId, items, approved, rejected, viewTarget]);

  // Reset search when switching user scope (search is tenant-scoped)
  useEffect(() => {
    setSearchResults(null);
    setSearchTotal(0);
    setPage(1);
  }, [effectiveUid]);

  const onSearchResults = (results: any[], t: number) => {
    setSearchResults(results);
    setSearchTotal(t);
    setPage(1);
  };

  const onSearchClear = () => {
    setSearchResults(null);
    setSearchTotal(0);
    setSearchQuery('');
  };

  const allLoaded = useMemo(() => [...items, ...approved, ...rejected], [items, approved, rejected]);
  const uniqueCategories = useMemo(
    () => [...new Set(allLoaded.map((r: any) => r.category).filter(Boolean))].sort(),
    [allLoaded],
  );
  const uniqueSuppliers = useMemo(
    () => [...new Set(allLoaded.map((r: any) => r.supplier).filter(Boolean))].sort(),
    [allLoaded],
  );

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
  const applyFilters = useCallback(
    (list: any[]) =>
      list.filter((r: any) => {
        const catMatch = filters.category ? r.category === filters.category : true;
        const supMatch = filters.supplier ? r.supplier === filters.supplier : true;
        if (!filters.dateStart && !filters.dateEnd) return catMatch && supMatch;
        const ts = parseReceiptTs(r.receiptDate || r.receipt_date || '');
        if (ts === null) return false;
        const s = parseFilterBound(filters.dateStart, false);
        const e = parseFilterBound(filters.dateEnd, true);
        return catMatch && supMatch && (s === null || ts >= s) && (e === null || ts <= e);
      }),
    [filters],
  );

  const listForTab = useMemo(() => {
    if (searchResults !== null) {
      // Rejection is an audit-derived state, not a persisted status, so
      // search results (which carry only the status) filter to the status
      // rejected receipts share: needs_review.
      const rejectedMatch = (r: any) => r.status === 'needs_review';
      return searchResults.filter((r: any) =>
        tab === 'pending' ? r.status === 'pending_approval'
          : tab === 'approved' ? r.status === 'processed'
            : rejectedMatch(r),
      );
    }
    return applyFilters(
      tab === 'pending' ? items : tab === 'approved' ? approved : rejected,
    );
  }, [searchResults, tab, items, approved, rejected, applyFilters]);

  // Group by batch name (receipts without a batch land in "Unbatched")
  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const r of listForTab) {
      const key = r.batchTitle || r.batch_title || 'Unbatched';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    const entries = [...map.entries()];
    entries.sort((a, b) => {
      const latest = (list: any[]) =>
        Math.max(...list.map((r) => new Date(r.createdAt || r.created_at || r.scannedAt || r.scanned_at || 0).getTime()), 0);
      return latest(b[1]) - latest(a[1]);
    });
    return entries;
  }, [listForTab]);

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const allCollapsed = groups.length > 0 && groups.every(([key]) => collapsed.has(key));
  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(groups.map(([key]) => key)));

  const confirmRecall = async () => {
    if (!recallTarget) return;
    setBusyId(recallTarget.id);
    try {
      await receiptApi.recall(effectiveUid!, recallTarget.id);
      setRecallTarget(null);
      await load();
    } catch (e: any) {
      setError(e.message || 'Recall failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleViewedSaved = (updated: any) => {
    setViewTarget(updated);
    setItems(prev => prev.map(r => r.id === updated.id ? { ...r, ...updated } : r));
    setApproved(prev => prev.map(r => r.id === updated.id ? { ...r, ...updated } : r));
    setRejected(prev => prev.map(r => r.id === updated.id ? { ...r, ...updated } : r));
    if (searchResults) setSearchResults(prev => prev ? prev.map((r: any) => r.id === updated.id ? { ...r, ...updated } : r) : prev);
    load();
  };

  const handleViewedDeleted = (id?: string) => {
    const delId = id || (viewTarget as any)?.id;
    setViewTarget(null);
    if (delId) {
      setItems(prev => prev.filter(r => r.id !== delId));
      setApproved(prev => prev.filter(r => r.id !== delId));
      setRejected(prev => prev.filter(r => r.id !== delId));
      if (searchResults) {
        setSearchResults(prev => prev ? prev.filter((r: any) => r.id !== delId) : prev);
        setSearchTotal(t => Math.max(0, t - 1));
      }
    }
    load();
  };

  const searchFilters = {
    status: tab === 'pending' ? 'pending_approval' : tab === 'approved' ? 'processed' : 'needs_review',
    category: filters.category || undefined,
    supplier: filters.supplier || undefined,
    dateFrom: filters.dateStart || undefined,
    dateTo: filters.dateEnd || undefined,
    rejected: tab === 'rejected' ? true : undefined,
  };
  async function loadSearchPage(pageNum: number) {
    if (!searchQuery.trim()) return;
    try {
      const result = await receiptApi.search(searchQuery.trim(), 25, (pageNum - 1) * 25, searchFilters);
      setSearchResults(result.results || []);
      setSearchTotal(result.total || 0);
    } catch {
      setSearchResults([]);
      setSearchTotal(0);
    }
  }

  // Table view — client-side filter + sort + pagination over current tab's rows
  const tableFiltered = useMemo(() => {
    const entries = Object.entries(columnFilters).filter(([, v]) => v);
    if (entries.length === 0) return listForTab;
    return listForTab.filter((r: any) => {
      for (const [k, v] of entries) {
        const raw = String(v);
        const val = cellValue(r, k);
        if (raw === '__BLANK__') { if (!isBlankCellValue(val)) return false; }
        else if (!val.toLowerCase().includes(raw.toLowerCase())) return false;
      }
      return true;
    });
  }, [listForTab, columnFilters]);
  const tableSorted = useMemo(() => {
    if (!tableSortBy) return tableFiltered;
    const dir = tableSortOrder === 'asc' ? 1 : -1;
    const colMap: Record<string, string> = {
      receipt_date: 'receiptDate', receiptDate: 'receiptDate',
      supplier: 'supplier', total_amount: 'totalAmount', totalAmount: 'totalAmount',
      tax_amount: 'taxAmount', taxAmount: 'taxAmount', category: 'category',
      status: 'status', invoice_number: 'invoiceNumber', invoiceNumber: 'invoiceNumber',
      entry_type: 'entryType', entryType: 'entryType', batch_title: 'batchTitle', batchTitle: 'batchTitle',
      location: 'location', kra_pin: 'kraPin', kraPin: 'kraPin', buyer_kra_pin: 'buyerKraPin', buyerKraPin: 'buyerKraPin',
      cu_invoice: 'cuInvoice', cuInvoice: 'cuInvoice', file_type: 'fileType', fileType: 'fileType',
    };
    const key = colMap[tableSortBy] || tableSortBy;
    const isDateKey = key === 'receiptDate';
    return [...tableFiltered].sort((a: any, b: any) => {
      const avRaw = a[key] ?? a[key.replace(/([A-Z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? '';
      const bvRaw = b[key] ?? b[key.replace(/([A-Z])/g, (_: string, c: string) => `_${c.toLowerCase()}`)] ?? '';
      if (isDateKey) {
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
  }, [tableFiltered, tableSortBy, tableSortOrder]);
  const tableTotal = tableSorted.length;
  const tableRows = useMemo(() => tableSorted.slice((tablePage - 1) * tablePageSize, tablePage * tablePageSize), [tableSorted, tablePage, tablePageSize]);
  const tablePages = Math.max(1, Math.ceil(tableTotal / tablePageSize));
  const handleTableSort = (sortBy: string | null, order: 'asc' | 'desc') => { setTableSortBy(sortBy); setTableSortOrder(order); setTablePage(1); };
  const handleTablePage = (p: number, s: number) => { setTablePage(p); setTablePageSize(s); };
  const handleColumnFilter = (k: string, v: string) => { setColumnFilters(prev => { const n = { ...prev, [k]: v }; if (!v) delete n[k]; return n; }); setTablePage(1); };
  const handleTableExport = () => { if (tableTotal === 0) return; setExportModalOpen(true); };
  const confirmTableExport = (filename: string) => {
    setExportModalOpen(false);
    setExporting(true);
    try {
      const cols = visibleColumnKeys(effectiveUid || null);
      exportRowsAsCsv(tableSorted, cols, filename);
    } catch (e: any) { alert(e?.message || 'Export failed'); } finally { setExporting(false); }
  };
  useEffect(() => { setTablePage(1); }, [tab, filters, searchResults]);

  const totalPages = Math.max(1, Math.ceil((searchResults !== null ? searchTotal : listForTab.length) / 25));

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pending', label: `Pending Approval (${items.length})` },
    { key: 'approved', label: `Approved (${approved.length})` },
    { key: 'rejected', label: `Rejected (${rejected.length})` },
  ];

  const clearAll = () => {
    setFilters({ category: '', supplier: '', dateStart: '', dateEnd: '' });
    onSearchClear();
  };

  return (
    <div className="p-4 sm:p-6 w-full">
      <h1 className="text-xl font-semibold mb-4 text-gray-800">My Documents</h1>

      <div className="flex gap-1 mb-4 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Indexed search + reused filters */}
      <div className="bg-white rounded-lg shadow p-3 mb-4 space-y-2">
        <SearchBar
          key={effectiveUid || 'my-approvals-search'}
          onResults={onSearchResults}
          onClear={onSearchClear}
          onQueryChange={setSearchQuery}
          searchKey={JSON.stringify({ tab, filters })}
          searchFn={(q, limit, offset) => receiptApi.search(q, limit, offset, searchFilters)}
        />
        <div className="flex flex-wrap gap-2">
          <select value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white">
            <option value="">All Categories</option>
            {uniqueCategories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={filters.supplier} onChange={(e) => setFilters((f) => ({ ...f, supplier: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white">
            <option value="">All Suppliers</option>
            {uniqueSuppliers.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input type="date" value={filters.dateStart} onChange={(e) => setFilters((f) => ({ ...f, dateStart: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Receipt Date Start" />
          <input type="date" value={filters.dateEnd} onChange={(e) => setFilters((f) => ({ ...f, dateEnd: e.target.value }))} className="px-2 py-1 text-xs border rounded bg-white" title="Receipt Date End" />
          {(Object.values(filters).some(Boolean) || searchResults !== null) && (
            <button onClick={clearAll} className="px-2 py-1 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* View toggle */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5">
          <button onClick={() => { setViewMode('table'); localStorage.setItem(VIEW_KEY, 'table'); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'table' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><Table2 className="h-4 w-4" /> Table</button>
          <button onClick={() => { setViewMode('grouped'); localStorage.setItem(VIEW_KEY, 'grouped'); }} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'grouped' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`}><LayoutGrid className="h-4 w-4" /> Grouped</button>
        </div>
        <span className="text-xs text-gray-400">{searchResults !== null ? `${searchTotal} match${searchTotal === 1 ? '' : 'es'}` : `${listForTab.length} receipt${listForTab.length === 1 ? '' : 's'} · ${groups.length} batch${groups.length === 1 ? '' : 'es'}`}</span>
      </div>

      {viewMode === 'table' ? (
        <>
          <ReceiptsTableView
            userId={effectiveUid || null}
            rows={tableRows}
            total={tableTotal}
            page={Math.min(tablePage, tablePages)}
            pageSize={tablePageSize}
            onPageChange={handleTablePage}
            sortBy={tableSortBy}
            sortOrder={tableSortOrder}
            onSortChange={handleTableSort}
            columnFilters={columnFilters}
            onColumnFilter={handleColumnFilter}
            loading={loading}
            onRowClick={(r: any) => setViewTarget(r)}
            onExport={handleTableExport}
            exporting={exporting}
            emptyText={searchResults !== null ? 'No matches' : tab === 'pending' ? 'Nothing pending approval' : tab === 'approved' ? 'No approved documents yet' : 'No rejected documents'}
          />
          <ExportNameModal open={exportModalOpen} count={tableTotal} defaultName={defaultExportName(`my_${tab}`, {}, tableTotal)} onConfirm={confirmTableExport} onCancel={() => setExportModalOpen(false)} />
        </>
      ) : (
      <>
      {/* Expand/collapse all + count */}
      {groups.length > 0 && (
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">
            {searchResults !== null ? `${searchTotal} match${searchTotal === 1 ? '' : 'es'}` : `${listForTab.length} receipt${listForTab.length === 1 ? '' : 's'} · ${groups.length} batch${groups.length === 1 ? '' : 'es'}`}
          </span>
          <button onClick={toggleAll} className="text-xs text-blue-600 hover:text-blue-700 font-medium">
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
        </div>
      ) : groups.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">{searchResults !== null ? '🔍' : tab === 'pending' ? '📨' : tab === 'approved' ? '✅' : '↩️'}</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">
            {searchResults !== null
              ? 'No matches'
              : tab === 'pending'
                ? 'Nothing pending approval'
                : tab === 'approved'
                  ? 'No approved documents yet'
                  : 'No rejected documents'}
          </h2>
          <p className="text-gray-500 text-sm">
            {searchResults !== null
              ? 'Try a different search term.'
              : tab === 'pending'
                ? 'Receipts you submit for approval will appear here.'
                : tab === 'approved'
                  ? 'Your approved receipts will be listed here.'
                  : 'Receipts the admin sent back will appear here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(([batch, rows]) => {
            const isCollapsedGroup = collapsed.has(batch);
            const sum = rows.reduce((s, r) => s + Number(r.totalAmount ?? r.total_amount ?? 0), 0);
            return (
              <div key={batch} className="bg-white rounded-lg shadow overflow-hidden">
                <div
                  onClick={() => toggleGroup(batch)}
                  className="flex items-center gap-2 px-3 py-2.5 bg-gray-50 border-b cursor-pointer select-none"
                >
                  <span className="text-gray-400 flex-shrink-0">
                    {isCollapsedGroup ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </span>
                  <span className="font-semibold text-sm text-gray-800 truncate">{batch}</span>
                  <span className="text-xs text-gray-400 flex-shrink-0">
                    {rows.length} receipt{rows.length === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto text-sm font-medium text-gray-700 flex-shrink-0">
                    KES {sum.toLocaleString()}
                  </span>
                </div>
                {!isCollapsedGroup && (
                  <div className="divide-y">
                    {rows.map((r: any) => (
                      <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-gray-800">
                            {r.supplier || '—'}
                          </div>
                          <div className="text-xs text-gray-400 truncate">
                            {r.receiptDate || r.receipt_date || '—'}
                            {r.location ? ` · ${r.location}` : ''}
                            {r.items?.length ? ` · ${r.items.length} item${r.items.length === 1 ? '' : 's'}` : ''}
                          </div>
                        </div>
                        <span className="text-sm font-medium text-gray-700 whitespace-nowrap">
                          KES {Number(r.totalAmount ?? r.total_amount ?? 0).toLocaleString()}
                        </span>
                        {tab === 'rejected' ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 bg-red-100 text-red-700">
                            Rejected
                          </span>
                        ) : (
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${receiptStatusClass(r.status)}`}>
                            {receiptStatusLabel(r.status)}
                          </span>
                        )}
                        {tab === 'pending' && (
                          <button
                            onClick={() => setRecallTarget(r)}
                            disabled={busyId === r.id}
                            className="px-2 py-1 text-xs rounded bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50 flex-shrink-0"
                          >
                            {busyId === r.id ? '…' : 'Recall'}
                          </button>
                        )}
                        {tab === 'approved' && !isAdmin && (
                          <span className="inline-flex items-center px-2 py-1 text-xs text-gray-400 flex-shrink-0">
                            Read-only
                          </span>
                        )}
                        <button
                          onClick={() => setViewTarget(r)}
                          className="px-2 py-1 text-xs rounded border text-gray-600 hover:bg-gray-100 flex-shrink-0"
                        >
                          View
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      </> )}
      {viewMode === 'grouped' && searchResults !== null && totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm text-gray-500">
          <button
            onClick={() => { const next = Math.max(1, page - 1); setPage(next); loadSearchPage(next); }}
            disabled={page <= 1}
            className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-gray-100"
          >Previous</button>
          <span>{page} / {totalPages}</span>
          <button
            onClick={() => { const next = Math.min(totalPages, page + 1); setPage(next); loadSearchPage(next); }}
            disabled={page >= totalPages}
            className="px-3 py-1 border rounded disabled:opacity-30 hover:bg-gray-100"
          >Next</button>
        </div>
      )}

      {error && (
        <div className="mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── View modal: shared ReviewPanel, admin actions disabled ── */}
      {viewTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl lg:max-w-[95vw] xl:max-w-6xl 2xl:max-w-7xl max-h-[92vh] lg:h-[92vh] flex flex-col">
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900">Receipt</h3>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {viewTarget.supplier || 'Receipt'} ·{' '}
                  {viewTarget.location || 'no location'} ·{' '}
                  {viewTarget.receiptDate || viewTarget.receipt_date || 'no date'} · KES{' '}
                  {Number(viewTarget.totalAmount ?? viewTarget.total_amount ?? 0).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => setViewTarget(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none flex-shrink-0"
                title="Close"
              >×</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {/* Guard rails: isAdmin=false hides Approve/Reject; approved
                  receipts are read-only via ReviewPanel itself. */}
              <ReviewPanel
                userId={effectiveUid || ''}
                receipt={viewTarget}
                setIsEditing={() => {}}
                isAdmin={false}
                useStore={false}
                onSaved={handleViewedSaved}
                onDeleted={handleViewedDeleted}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Recall confirm modal (replaces browser confirm) ── */}
      {recallTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Recall Receipt</h3>
            <p className="text-sm text-gray-600">
              Recall <strong>{recallTarget.supplier || 'this receipt'}</strong> back to review so you can edit it?
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setRecallTarget(null)}
                disabled={busyId === recallTarget.id}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmRecall}
                disabled={busyId === recallTarget.id}
                className="px-4 py-2 text-white bg-gray-600 rounded hover:bg-gray-700 disabled:opacity-50"
              >
                {busyId === recallTarget.id ? 'Recalling…' : 'Recall'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MyApprovalsPage;
