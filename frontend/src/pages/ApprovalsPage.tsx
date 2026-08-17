// src/pages/ApprovalsPage.tsx
import { useState, useEffect, useCallback } from 'react';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { receiptStatusLabel, receiptStatusClass } from '../utils/receiptStatus';
import ReviewPanel from '../components/ReviewPanel';
import { ChevronLeft, ChevronRight } from 'lucide-react';

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
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [page, setPage] = useState(1);
  // Unsaved-changes confirm when switching receipts mid-edit (modal, no browser confirm)
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await receiptApi.listPendingApproval();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e: any) {
      console.error('Failed to load approvals', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

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

  const selectedRow = items.find((r: any) => r.id === selectedId) || null;

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
  // the panel to the next one so it never dangles on stale/blank data.
  const advancePast = (removedId: string) => {
    setSelectedReceipt(null);
    const remaining = items.filter((r: any) => r.id !== removedId);
    if (remaining.length > 0) setSelectedId(remaining[0].id);
    else setSelectedId(null);
    load();
  };

  const handleSaved = (updated: any) => {
    if (updated?.status === 'pending_approval') {
      setSelectedReceipt(updated);
      load();
    } else {
      advancePast(updated?.id as string);
    }
  };

  const handleDeleted = (id: string) => advancePast(id);

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

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageItems = items.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  /* ── Sidebar contents (shared between desktop inline & mobile overlay) ── */
  const SidebarBody = (
    <>
      {/* Sidebar header */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b bg-gray-50">
        <span className="text-sm font-semibold text-gray-700 truncate">
          Pending Approvals
          <span className="ml-1.5 text-xs font-normal text-gray-400">{items.length}</span>
        </span>
        <button
          onClick={() => setSidebarOpen(false)}
          className="p-1 rounded hover:bg-gray-200 text-gray-500"
          title="Collapse"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto divide-y">
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
                  src={`/api/images/cached?url=${encodeURIComponent(row.imageUrl)}`}
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
          {`${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, items.length)}`}
          {' '}/ {items.length}
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

      {/* ── Top bar with sidebar toggle ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 bg-white border-b shadow-sm">
        <button
          onClick={() => setSidebarOpen(o => !o)}
          className="flex-shrink-0 p-1.5 rounded border hover:bg-gray-100 text-gray-600"
          title={sidebarOpen ? 'Collapse list' : 'Expand list'}
        >
          {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <h1 className="font-semibold text-sm text-gray-700">Pending Approvals</h1>
        <span className="text-xs text-gray-400">{total} across all users</span>
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