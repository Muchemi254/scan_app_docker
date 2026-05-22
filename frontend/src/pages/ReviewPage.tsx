// src/pages/ReviewPage.tsx
import { useEffect, useState } from 'react';
import { useReceiptStore } from '../stores/receiptStore';
import type { ReceiptData } from '../types/gemini';
import ReviewPanel from '../components/ReviewPanel';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const PAGE_SIZE = 25;

const ReviewPage = ({ userId }: { userId: string | null }) => {
  const { items: allReceipts, loading, load } = useReceiptStore();
  const receipts = allReceipts.filter(r => r.status === 'needs_review') as ReceiptData[];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1024);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!userId) return;
    load(userId);
  }, [userId, load]);

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

  const handleSelect = (newId: string) => {
    if (isEditing) {
      if (!confirm('You have unsaved changes. Do you want to discard them and switch receipts?')) return;
    }
    setSelectedId(newId);
    if (window.innerWidth < 1024) setSidebarOpen(false);
  };

  const totalPages = Math.max(1, Math.ceil(receipts.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pageReceipts = receipts.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);
  const selected = receipts.find(r => r.id === selectedId);

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

  if (!loading && receipts.length === 0) {
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
          <span className="ml-1.5 text-xs font-normal text-gray-400">{receipts.length}</span>
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
        {pageReceipts.map(receipt => (
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
        ))}
      </div>

      {/* Pagination */}
      <div className="flex-shrink-0 border-t px-3 py-2 flex items-center justify-between text-xs text-gray-500 bg-gray-50">
        <span>
          {`${(clampedPage - 1) * PAGE_SIZE + 1}–${Math.min(clampedPage * PAGE_SIZE, receipts.length)}`}
          {' '}/ {receipts.length}
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
        <span className="font-semibold text-sm text-gray-700">Needs Review</span>
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
            <ReviewPanel userId={userId!} receipt={selected} setIsEditing={setIsEditing} />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Select a receipt to review
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ReviewPage;
