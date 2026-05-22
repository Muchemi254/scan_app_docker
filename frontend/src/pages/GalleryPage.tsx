import { useEffect, useState, useCallback } from 'react';
import { receiptApi } from '../services/api';
import ImageViewer from '../components/ImageViewer';
import {
  Search, Image, X, ChevronLeft, ChevronRight,
  FolderOpen, Calendar, Layers, ArrowLeft
} from 'lucide-react';

const PAGE_SIZE = 20;

interface ReceiptGroup {
  batchTitle: string;
  count: number;
  thumbnailUrl: string | null;
  totalAmount: number;
  latestDate: string | null;
  firstSupplier: string | null;
}

const GalleryPage = ({ userId }: { userId: string | null }) => {
  // Groups state
  const [groups, setGroups] = useState<ReceiptGroup[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);

  // Active group detail state
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  // Selected receipt for fullscreen view
  const [selectedReceipt, setSelectedReceipt] = useState<any | null>(null);

  // Load groups on mount
  useEffect(() => {
    if (!userId) return;
    setLoadingGroups(true);
    receiptApi.getGroups()
      .then(res => setGroups(res.groups || []))
      .catch(err => console.error('Failed to load receipt groups:', err))
      .finally(() => setLoadingGroups(false));
  }, [userId]);

  // Load receipts for active group
  const loadReceipts = useCallback(async (groupTitle: string, pageNum: number) => {
    if (!userId) return;
    setLoadingReceipts(true);
    try {
      const skip = (pageNum - 1) * PAGE_SIZE;
      const filters: any = {};
      if (groupTitle === 'Ungrouped') {
        filters.batchTitle = '__ungrouped__';
      } else {
        filters.batchTitle = groupTitle;
      }
      const res = await receiptApi.list(skip, PAGE_SIZE, filters);
      setReceipts((res.items || []).filter((r: any) => r.imageUrl));
      setTotal(res.total);
    } catch (err) {
      console.error('Failed to load receipts:', err);
    } finally {
      setLoadingReceipts(false);
    }
  }, [userId]);

  // Open a group
  const openGroup = (groupTitle: string) => {
    setActiveGroup(groupTitle);
    setPage(1);
    setSearchQuery('');
    loadReceipts(groupTitle, 1);
  };

  // Back to groups
  const backToGroups = () => {
    setActiveGroup(null);
    setReceipts([]);
    setPage(1);
    setSearchQuery('');
  };

  // Page change
  const goToPage = (newPage: number) => {
    setPage(newPage);
    if (activeGroup) loadReceipts(activeGroup, newPage);
  };

  // Client-side search filter within loaded receipts
  const displayedReceipts = searchQuery && activeGroup
    ? receipts.filter(r =>
        (r.supplier || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (r.category || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : receipts;

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Loading: groups ──
  if (loadingGroups) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  // ── Group grid view ──
  if (!activeGroup) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <FolderOpen className="h-7 w-7 text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">Receipt Gallery</h1>
          <span className="text-sm text-gray-500 font-medium">
            ({groups.length} {groups.length === 1 ? 'group' : 'groups'})
          </span>
        </div>

        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Image className="h-16 w-16 mb-4" />
            <p className="text-lg font-medium">No receipt images found</p>
            <p className="text-sm mt-1">Receipts with images will appear here after scanning.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {groups.map(group => (
              <button
                key={group.batchTitle}
                onClick={() => openGroup(group.batchTitle)}
                className="group bg-white rounded-xl border border-gray-200 overflow-hidden hover:shadow-lg hover:border-blue-300 transition-all text-left focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {/* Thumbnail */}
                <div className="aspect-[4/3] bg-gray-100 relative overflow-hidden">
                  {group.thumbnailUrl ? (
                    <img
                      src={`/api/images/cached?url=${encodeURIComponent(group.thumbnailUrl)}&thumb=1`}
                      alt={group.batchTitle}
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-gray-300">
                      <Image className="h-12 w-12" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors" />
                  {/* Count badge */}
                  <span className="absolute top-2 right-2 bg-black/70 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
                    {group.count} {group.count === 1 ? 'image' : 'images'}
                  </span>
                </div>

                {/* Info */}
                <div className="p-3.5">
                  <div className="flex items-center gap-2 mb-1">
                    <Layers className="h-4 w-4 text-blue-500 flex-shrink-0" />
                    <h3 className="font-semibold text-gray-900 truncate text-sm">
                      {group.batchTitle}
                    </h3>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500 mt-2">
                    <span className="font-medium text-blue-600">
                      KES {group.totalAmount.toLocaleString()}
                    </span>
                    {group.latestDate && (
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {group.latestDate}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Group detail view (paginated images) ──
  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Header with back button */}
      <div className="flex items-center justify-between gap-4 mb-6 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={backToGroups}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 flex-shrink-0"
            title="Back to groups"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Image className="h-7 w-7 text-blue-600 flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900 truncate">
              {activeGroup}
            </h1>
            <p className="text-sm text-gray-500">
              {total} receipt{total !== 1 ? 's' : ''} — Page {page} of {totalPages}
            </p>
          </div>
        </div>

        {/* Search within group */}
        <div className="relative w-full sm:w-56">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter by name..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
      </div>

      {/* Loading spinner */}
      {loadingReceipts ? (
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
        </div>
      ) : displayedReceipts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400">
          <Image className="h-16 w-16 mb-4" />
          <p className="text-lg font-medium">No images in this group</p>
        </div>
      ) : (
        <>
          {/* Image grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {displayedReceipts.map(receipt => (
              <button
                key={receipt.id}
                onClick={() => setSelectedReceipt(receipt)}
                className="group relative bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-lg hover:border-blue-300 transition-all text-left focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <div className="aspect-[3/4] bg-gray-100 relative overflow-hidden">
                  <img
                    src={`/api/images/cached?url=${encodeURIComponent(receipt.imageUrl)}&thumb=1`}
                    alt={receipt.supplier || 'Receipt'}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
                <div className="p-2">
                  <p className="text-xs font-semibold text-gray-800 truncate">
                    {receipt.supplier || 'Unknown'}
                  </p>
                  <p className="text-[10px] text-gray-400 truncate">
                    {receipt.receiptDate || ''}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Pagination controls */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <button
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                className="p-2 rounded-lg border hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                let pageNum: number;
                if (totalPages <= 7) {
                  pageNum = i + 1;
                } else if (page <= 4) {
                  pageNum = i + 1;
                } else if (page >= totalPages - 3) {
                  pageNum = totalPages - 6 + i;
                } else {
                  pageNum = page - 3 + i;
                }
                return (
                  <button
                    key={pageNum}
                    onClick={() => goToPage(pageNum)}
                    className={`w-9 h-9 rounded-lg text-sm font-medium transition-colors ${
                      pageNum === page
                        ? 'bg-blue-600 text-white'
                        : 'hover:bg-gray-100 text-gray-700'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
              <button
                onClick={() => goToPage(page + 1)}
                disabled={page >= totalPages}
                className="p-2 rounded-lg border hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          )}
        </>
      )}

      {/* Fullscreen receipt viewer */}
      {selectedReceipt && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedReceipt(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b sticky top-0 bg-white z-10">
              <div className="min-w-0">
                <h2 className="font-bold text-lg truncate">{selectedReceipt.supplier}</h2>
                <p className="text-sm text-gray-500 truncate">
                  {selectedReceipt.category} — {selectedReceipt.receiptDate}
                </p>
              </div>
              <button
                onClick={() => setSelectedReceipt(null)}
                className="p-1.5 rounded hover:bg-gray-100 text-gray-500 flex-shrink-0"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4">
              <ImageViewer
                imageUrl={selectedReceipt.imageUrl}
                altText={selectedReceipt.supplier || 'Receipt'}
                containerClass="min-h-[50vh] max-h-[70vh]"
              />
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex flex-wrap gap-4 text-sm">
              <div>
                <span className="text-gray-500">Total:</span>{' '}
                <span className="font-semibold">{selectedReceipt.totalAmount}</span>
              </div>
              <div>
                <span className="text-gray-500">Date:</span>{' '}
                <span>{selectedReceipt.receiptDate}</span>
              </div>
              <div>
                <span className="text-gray-500">Invoice:</span>{' '}
                <span>{selectedReceipt.invoiceNumber || 'N/A'}</span>
              </div>
              {selectedReceipt.batchTitle && (
                <div>
                  <span className="text-gray-500">Batch:</span>{' '}
                  <span>{selectedReceipt.batchTitle}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default GalleryPage;
