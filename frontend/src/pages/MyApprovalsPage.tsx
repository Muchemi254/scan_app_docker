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
import { ChevronDown, ChevronRight } from 'lucide-react';

type Tab = 'pending' | 'approved';

/**
 * User-facing document pipeline page.
 *
 * - Pending Approval: receipts awaiting an admin decision (Recall → back to
 *   review for editing, or View).
 * - Approved: finalized receipts — read-only, cannot be re-edited.
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
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallTarget, setRecallTarget] = useState<any | null>(null);

  // Indexed search (reused from the receipt search endpoint)
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);

  // Client-side filters (same pattern as the main receipts list)
  const [filters, setFilters] = useState({
    category: '', supplier: '', dateStart: '', dateEnd: '',
  });

  // View modal — shows the shared ReviewPanel with admin actions disabled
  const [viewTarget, setViewTarget] = useState<any | null>(null);

  // Collapsible batch groups (default collapsed so the list stays short)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!effectiveUid) return;
    setLoading(true);
    try {
      const [p, a] = await Promise.all([
        receiptApi.list(0, 1000, { status: 'pending_approval' }),
        receiptApi.list(0, 1000, { status: 'processed' }),
      ]);
      setItems(p.items || []);
      setApproved(a.items || []);
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
    const found = [...items, ...approved].find(r => r.id === deepLinkId);
    if (found) setViewTarget(found);
  }, [deepLinkId, items, approved, viewTarget]);

  // Reset search when switching user scope (search is tenant-scoped)
  useEffect(() => {
    setSearchResults(null);
    setSearchTotal(0);
  }, [effectiveUid]);

  const onSearchResults = (results: any[], t: number) => {
    setSearchResults(results);
    setSearchTotal(t);
  };

  const onSearchClear = () => {
    setSearchResults(null);
    setSearchTotal(0);
  };

  const allLoaded = useMemo(() => [...items, ...approved], [items, approved]);
  const uniqueCategories = useMemo(
    () => [...new Set(allLoaded.map((r: any) => r.category).filter(Boolean))].sort(),
    [allLoaded],
  );
  const uniqueSuppliers = useMemo(
    () => [...new Set(allLoaded.map((r: any) => r.supplier).filter(Boolean))].sort(),
    [allLoaded],
  );

  const applyFilters = useCallback(
    (list: any[]) =>
      list.filter((r: any) => {
        const catMatch = filters.category ? r.category === filters.category : true;
        const supMatch = filters.supplier ? r.supplier === filters.supplier : true;
        const d = new Date(r.receiptDate || r.receipt_date || '');
        const s = filters.dateStart ? new Date(filters.dateStart) : null;
        const e = filters.dateEnd ? new Date(filters.dateEnd) : null;
        if (e) e.setHours(23, 59, 59, 999);
        const dateMatch = (!s || d >= s) && (!e || d <= e);
        return catMatch && supMatch && dateMatch;
      }),
    [filters],
  );

  const listForTab = useMemo(() => {
    if (searchResults !== null) {
      return searchResults.filter((r: any) =>
        tab === 'pending' ? r.status === 'pending_approval' : r.status === 'processed',
      );
    }
    return applyFilters(tab === 'pending' ? items : approved);
  }, [searchResults, tab, items, approved, applyFilters]);

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
    load();
  };

  const handleViewedDeleted = () => {
    setViewTarget(null);
    load();
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pending', label: `Pending Approval (${items.length})` },
    { key: 'approved', label: `Approved (${approved.length})` },
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
          onResults={onSearchResults}
          onClear={onSearchClear}
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
          <div className="text-5xl mb-4">{searchResults !== null ? '🔍' : tab === 'pending' ? '📨' : '✅'}</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">
            {searchResults !== null
              ? 'No matches'
              : tab === 'pending'
                ? 'Nothing pending approval'
                : 'No approved documents yet'}
          </h2>
          <p className="text-gray-500 text-sm">
            {searchResults !== null
              ? 'Try a different search term.'
              : tab === 'pending'
                ? 'Receipts you submit for approval will appear here.'
                : 'Your approved receipts will be listed here.'}
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
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium flex-shrink-0 ${receiptStatusClass(r.status)}`}>
                          {receiptStatusLabel(r.status)}
                        </span>
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
                userId={effectiveUid}
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