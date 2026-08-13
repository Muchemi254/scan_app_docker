/**
 * ScannerPage — backend-driven batch scanning.
 *
 * Processing runs entirely on the server, so:
 *  - Hard refresh or navigation away does NOT interrupt scanning.
 *  - On return we re-fetch every active batch for this user and render
 *    them all as stacked panels (no tabs, no hidden background work).
 *
 * UI sections (top to bottom):
 *   1. New-scan form (or upload progress while files are uploading).
 *   2. A stacked list of every active batch for this user — including
 *      sub-batches auto-split from a single big selection (e.g. "v140626 1",
 *      "v140626 2", "v140626 3"). Each panel polls its own progress.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { batchApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import { toast } from '../stores/toastStore';

// ─── Types ────────────────────────────────────────────────────────────────

type ItemStatus = 'pending' | 'optimizing' | 'processing' | 'done' | 'needs_review' | 'failed' | 'duplicate';
type ItemStage = 'queued' | 'optimizing' | 'extracting' | 'parsing' | 'saving' | 'done';
type ChunkStatus = 'pending' | 'extracting' | 'saving' | 'done' | 'failed';

interface BatchItem {
  index: number;
  filename: string;
  origFilename?: string | null;
  status: ItemStatus;
  stage?: ItemStage;
  chunkIndex?: number | null;
  receiptId: string | null;
  message: string | null;
  errorCode?: string | null;
}

interface BatchChunk {
  index: number;
  itemRange: [number, number];
  size: number;
  status: ChunkStatus;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

interface Batch {
  batchId: string;
  userId: string;
  batchTitle: string;
  status: 'uploading' | 'processing' | 'done' | 'failed';
  createdAt: number;
  items: BatchItem[];
  chunks?: BatchChunk[];
}

// Mirrors backend/app/services/error_codes.py — keep in sync.
const ERROR_MESSAGES: Record<string, string> = {
  AI_RATE_LIMIT: 'AI rate-limited — will retry automatically.',
  AI_QUOTA_EXCEEDED: 'AI quota exhausted — check your API plan.',
  AI_AUTH_FAILED: 'AI API key was rejected — update it in Settings.',
  AI_TIMEOUT: 'AI timed out — will retry.',
  AI_INVALID_JSON: 'AI returned malformed data — retrying per-image.',
  AI_EMPTY_RESPONSE: 'AI returned no data for this image.',
  AI_PROVIDER_ERROR: 'AI provider error — will retry.',
  NETWORK_ERROR: 'Network error — will retry.',
  IMAGE_INVALID: 'Image could not be read.',
  IMAGE_TOO_LARGE: 'Image is too large to process.',
  SAVE_FAILED: 'Failed to save receipt to database.',
  UNKNOWN: 'Unexpected error.',
};

const STAGE_LABELS: Record<ItemStage, string> = {
  queued: 'Queued',
  optimizing: 'Optimizing',
  extracting: 'AI extracting',
  parsing: 'Parsing AI response',
  saving: 'Saving',
  done: 'Done',
};

const POLL_INTERVAL_MS = 2000;
const MAX_UPLOAD_SIZE_MB = 500;
const CHUNK_SIZE_MB = 250;  // frontend auto-splits selections above this into separate batches

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const ScannerPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const { invalidate } = useReceiptStore();

  // Every active batch for this user — uploading, processing, done, or failed.
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Upload phase state (only set while a new scan is being uploaded).
  type UploadPhase = {
    chunkIndex: number;
    totalChunks: number;
    percent: number;
    totalFiles: number;
  } | null;
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>(null);

  // New-scan form state
  const [batchTitle, setBatchTitle] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState('');

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
  const isOverLimit = totalSize > MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  const willChunk = totalSize > CHUNK_SIZE_MB * 1024 * 1024;
  const chunkCount = willChunk ? Math.ceil(totalSize / (CHUNK_SIZE_MB * 1024 * 1024)) : 1;

  // Client-side duplicate detection (filename+size+mtime).
  const [duplicates, setDuplicates] = useState<Map<string, File[]>>(new Map());
  function fingerprint(file: File): string {
    return `${file.size}_${file.lastModified}_${file.name}`;
  }
  function detectDuplicates(files: File[]): Map<string, File[]> {
    const groups = new Map<string, File[]>();
    for (const f of files) {
      const fp = fingerprint(f);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp)!.push(f);
    }
    const dupes = new Map<string, File[]>();
    for (const [k, v] of groups) if (v.length > 1) dupes.set(k, v);
    return dupes;
  }
  const totalDupes = Array.from(duplicates.values()).reduce((acc, g) => acc + g.length - 1, 0);

  // Per-batch retry-in-flight state, keyed by `${batchId}:${chunkIndex}`.
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailures = useRef(0);
  const prevStatusRef = useRef<Record<string, string>>({});

  // ── Fetch every active batch from the server ─────────────────────────

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const list: Batch[] = await batchApi.listActive();
      setBatches(list);
      pollFailures.current = 0;

      // Surface status transitions the user might otherwise miss.
      const prev = prevStatusRef.current;
      for (const b of list) {
        const prior = prev[b.batchId];
        if (!prior || prior === b.status) continue;
        if (b.status === 'done') {
          toast.success(`Batch complete: ${b.batchTitle}`);
        } else if (b.status === 'failed') {
          const failed = b.items.filter(i => i.status === 'failed').length;
          toast.error(
            `Batch failed: ${b.batchTitle}`,
            `${failed} of ${b.items.length} item(s) failed. Review in Notifications.`,
            { duration: 8000 }
          );
        }
      }
      const next: Record<string, string> = {};
      for (const b of list) next[b.batchId] = b.status;
      prevStatusRef.current = next;
    } catch {
      pollFailures.current += 1;
      if (pollFailures.current === 1) {
        toast.error('Lost connection to the server', 'Retrying automatically…', { duration: 6000 });
      }
    } finally {
      setLoaded(true);
    }
  }, [userId]);

  // Initial fetch
  useEffect(() => {
    if (!userId) return;
    setLoaded(false);
    refresh();
  }, [userId, refresh]);

  // Background polling — only while any batch is live or while we're uploading.
  useEffect(() => {
    if (!userId) return;
    const anyLive =
      uploadPhase !== null ||
      batches.some(b => b.status === 'uploading' || b.status === 'processing');
    if (!anyLive) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return; // already running
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [userId, batches, uploadPhase, refresh]);

  // Invalidate the receipt store whenever a batch transitions to done.
  const prevDoneCount = useRef(0);
  useEffect(() => {
    const doneNow = batches.filter(b => b.status === 'done').length;
    if (doneNow > prevDoneCount.current) invalidate();
    prevDoneCount.current = doneNow;
  }, [batches, invalidate]);

  // ── Start a new scan ──────────────────────────────────────────────────

  const handleProcess = async () => {
    if (!userId) return;
    if (!batchTitle.trim()) { setFormError('Enter a batch title.'); return; }
    if (selectedFiles.length === 0) { setFormError('Select at least one image.'); return; }
    setFormError('');

    // Build sub-batches by size (one if < 250MB, otherwise auto-split).
    const chunks: File[][] = [];
    let currentChunk: File[] = [];
    let currentSize = 0;
    for (const f of selectedFiles) {
      if (currentSize + f.size > CHUNK_SIZE_MB * 1024 * 1024 && currentChunk.length > 0) {
        chunks.push(currentChunk); currentChunk = []; currentSize = 0;
      }
      currentChunk.push(f); currentSize += f.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    try {
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkTitle = chunks.length > 1 ? `${batchTitle.trim()} ${ci + 1}` : batchTitle.trim();

        setUploadPhase({ chunkIndex: ci, totalChunks: chunks.length, percent: 0, totalFiles: chunk.length });

        const { batchId } = await batchApi.create(chunkTitle, chunk.map(f => f.name));
        try {
          await batchApi.process(batchId, chunk, (percent) => {
            setUploadPhase(p => p ? { ...p, percent } : p);
          });
        } catch (uploadErr) {
          await batchApi.dismiss(batchId).catch(() => {});
          throw uploadErr;
        }
        // Refresh so the new batch appears in the stack immediately.
        await refresh();
      }
    } catch (err: any) {
      setFormError(err.message ?? 'Upload failed — please try again.');
      toast.error('Upload failed', err?.message ?? 'Please try again.');
    } finally {
      setUploadPhase(null);
      setSelectedFiles([]);
      setBatchTitle('');
      setDuplicates(new Map());
      await refresh();
    }
  };

  // ── Per-batch actions ─────────────────────────────────────────────────

  const handleDismiss = async (batchId: string) => {
    try { await batchApi.dismiss(batchId); } catch {/* best-effort */}
    setBatches(prev => prev.filter(b => b.batchId !== batchId));
  };

  const handleRetryChunk = async (batchId: string, chunkIndex: number) => {
    const key = `${batchId}:c${chunkIndex}`;
    setRetrying(prev => new Set(prev).add(key));
    try {
      await batchApi.retryChunk(batchId, chunkIndex);
      await refresh();
      toast.info('Chunk retry queued', 'This chunk will re-process on the server.');
    } catch (e: any) {
      console.error('Retry chunk failed', e);
      toast.error('Retry chunk failed', e?.message ?? 'Please try again.');
    } finally {
      setRetrying(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleRetryItem = async (batchId: string, itemIndex: number) => {
    const key = `${batchId}:i${itemIndex}`;
    setRetrying(prev => new Set(prev).add(key));
    try {
      await batchApi.retryItem(batchId, itemIndex);
      await refresh();
      toast.info('Item retry queued', 'This image will re-extract on the server.');
    } catch (e: any) {
      console.error('Retry item failed', e);
      toast.error('Retry failed', e?.message ?? 'Please try again.');
    } finally {
      setRetrying(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  // Items with these error codes are account-level and can't be salvaged by retrying.
  const HARD_FAIL_CODES = new Set(['AI_QUOTA_EXCEEDED', 'AI_AUTH_FAILED']);

  // ── Render helpers (per-batch panel) ──────────────────────────────────

  const statusDot = (s: ItemStatus, stage: ItemStage | undefined, message: string | null, errorCode?: string | null) => {
    const map: Record<ItemStatus, string> = {
      pending: 'text-gray-400', optimizing: 'text-purple-500', processing: 'text-blue-500',
      done: 'text-green-600', needs_review: 'text-yellow-600', failed: 'text-red-600', duplicate: 'text-gray-500',
    };
    const icons: Record<ItemStatus, string> = {
      pending: '⏳', optimizing: '⚙️', processing: '🤖', done: '✅',
      needs_review: '⚠️', failed: '❌', duplicate: '🔁',
    };
    const label =
      s === 'processing' && stage ? STAGE_LABELS[stage] :
      s === 'duplicate' ? 'duplicate' :
      s.replace('_', ' ');
    const detail = errorCode && ERROR_MESSAGES[errorCode] ? ERROR_MESSAGES[errorCode] : message;
    return (
      <div className="flex flex-col items-end">
        <span className={`text-xs font-semibold ${map[s]}`}>{icons[s]} {label}</span>
        {detail && (
          <span className="text-[10px] text-gray-400 mt-0.5 max-w-[180px] truncate text-right" title={detail}>{detail}</span>
        )}
      </div>
    );
  };

  const chunkBadge = (status: ChunkStatus) => {
    const map: Record<ChunkStatus, [string, string]> = {
      pending:    ['bg-gray-100 text-gray-600',     '⏳ Queued'],
      extracting: ['bg-blue-100 text-blue-700',     '🤖 Extracting'],
      saving:     ['bg-indigo-100 text-indigo-700', '💾 Saving'],
      done:       ['bg-green-100 text-green-700',   '✅ Done'],
      failed:     ['bg-red-100 text-red-700',       '❌ Failed'],
    };
    const [cls, label] = map[status];
    return <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{label}</span>;
  };

  const renderBatchPanel = (batch: Batch) => {
    const doneCount      = batch.items.filter(i => i.status === 'done').length;
    const reviewCount    = batch.items.filter(i => i.status === 'needs_review').length;
    const failedCount    = batch.items.filter(i => i.status === 'failed').length;
    const duplicateCount = batch.items.filter(i => i.status === 'duplicate').length;
    const optimizingCount= batch.items.filter(i => i.status === 'optimizing').length;
    const processingCount= batch.items.filter(i => i.status === 'processing').length;
    const totalCount     = batch.items.length;
    const finishedCount  = doneCount + reviewCount + failedCount + duplicateCount;
    const isLive         = batch.status === 'uploading' || batch.status === 'processing';

    const itemsByChunk = (() => {
      const map = new Map<number | 'ungrouped', BatchItem[]>();
      for (const it of batch.items) {
        const key = it.chunkIndex ?? 'ungrouped';
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(it);
      }
      return Array.from(map.entries()).sort((a, b) => {
        if (a[0] === 'ungrouped') return 1;
        if (b[0] === 'ungrouped') return -1;
        return (a[0] as number) - (b[0] as number);
      });
    })();

    const headerBadge =
      batch.status === 'done'       ? <span className="text-xs text-green-600 font-medium">✅ Complete</span> :
      batch.status === 'failed'     ? <span className="text-xs text-red-600 font-medium">❌ Failed</span> :
      batch.status === 'processing' ? <span className="flex items-center gap-1.5 text-xs text-blue-600">
                                         <span className="animate-spin inline-block h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full" />
                                         Processing…
                                       </span> :
      <span className="text-xs text-gray-500">⏳ Uploading…</span>;

    return (
      <div key={batch.batchId} className="bg-white border rounded-lg shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-gray-50">
          <div className="flex items-center gap-3 min-w-0">
            <span className="font-semibold text-gray-800 truncate">{batch.batchTitle}</span>
            {headerBadge}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {!isLive && reviewCount > 0 && (
              <button
                onClick={() => { invalidate(); navigate('/review'); }}
                className="px-2 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600"
              >
                Review {reviewCount}
              </button>
            )}
            {!isLive && (
              <button
                onClick={() => handleDismiss(batch.batchId)}
                className="px-2 py-1 text-xs border rounded text-gray-600 hover:bg-gray-100"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>

        <div className="p-3 space-y-3">
          {/* Counts strip */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[10px] sm:text-xs text-gray-500">
            <div className="flex flex-col border-l-2 border-green-500 pl-2">
              <span className="text-green-600 font-bold uppercase tracking-wider">Saved</span>
              <span>{doneCount + reviewCount}</span>
            </div>
            <div className="flex flex-col border-l-2 border-purple-500 pl-2">
              <span className="text-purple-600 font-bold uppercase tracking-wider">Optimizing</span>
              <span>{optimizingCount}</span>
            </div>
            <div className="flex flex-col border-l-2 border-blue-500 pl-2">
              <span className="text-blue-600 font-bold uppercase tracking-wider">AI</span>
              <span>{processingCount}</span>
            </div>
            <div className="flex flex-col border-l-2 border-gray-400 pl-2">
              <span className="text-gray-600 font-bold uppercase tracking-wider">Duplicates</span>
              <span>{duplicateCount}</span>
            </div>
            <div className="flex flex-col border-l-2 border-red-500 pl-2">
              <span className="text-red-600 font-bold uppercase tracking-wider">Failed</span>
              <span>{failedCount}</span>
            </div>
          </div>

          {/* Progress bar */}
          {totalCount > 0 && (
            <div className="space-y-1">
              <div className="flex justify-between text-[10px] text-gray-400 font-medium px-1">
                <span>Progress</span>
                <span>{Math.round((finishedCount / totalCount) * 100)}% ({finishedCount}/{totalCount})</span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden border">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 transition-all duration-500"
                  style={{ width: `${(finishedCount / totalCount) * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* Chunk-grouped items */}
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1 border-t pt-2">
            {itemsByChunk.map(([chunkKey, items]) => {
              const chunkMeta = typeof chunkKey === 'number'
                ? batch.chunks?.find(c => c.index === chunkKey)
                : undefined;
              const totalChunks = batch.chunks?.length ?? 0;
              const isUngrouped = chunkKey === 'ungrouped';
              const header = isUngrouped
                ? (totalChunks === 0 ? `Items (${items.length})` : `Pre-extraction (${items.length})`)
                : `Chunk ${(chunkKey as number) + 1} of ${totalChunks} (${items.length})`;
              const key = `${batch.batchId}:c${typeof chunkKey === 'number' ? chunkKey : -1}`;
              return (
                <div key={String(chunkKey)} className="border rounded overflow-hidden">
                  <div className="flex items-center justify-between gap-2 bg-gray-50 px-3 py-1.5 border-b">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-semibold text-gray-700 truncate">{header}</span>
                      {chunkMeta && chunkBadge(chunkMeta.status)}
                      {chunkMeta && chunkMeta.attempts > 1 && (
                        <span className="text-[10px] text-gray-500">attempt {chunkMeta.attempts}</span>
                      )}
                    </div>
                    {chunkMeta?.status === 'failed' && (
                      <button
                        onClick={() => handleRetryChunk(batch.batchId, chunkMeta.index)}
                        disabled={retrying.has(key)}
                        className="px-2 py-0.5 text-[11px] bg-red-100 text-red-700 hover:bg-red-200 rounded border border-red-200 disabled:opacity-50"
                        title={chunkMeta.errorMessage || undefined}
                      >
                        {retrying.has(key) ? 'Retrying…' : '↻ Retry chunk'}
                      </button>
                    )}
                  </div>
                  {chunkMeta?.status === 'failed' && chunkMeta.errorCode && (
                    <div className="px-3 py-1 bg-red-50 border-b border-red-100 text-[11px] text-red-700">
                      <span className="font-medium">{chunkMeta.errorCode}:</span>{' '}
                      {ERROR_MESSAGES[chunkMeta.errorCode] || chunkMeta.errorMessage || 'Unknown error'}
                    </div>
                  )}
                  <div className="divide-y">
                    {items.map(item => {
                      const itemKey = `${batch.batchId}:i${item.index}`;
                      const canRetry =
                        item.status === 'failed' &&
                        !HARD_FAIL_CODES.has(item.errorCode || '');
                      return (
                        <div
                          key={item.index}
                          className={`flex items-center justify-between gap-3 px-3 py-1.5 text-sm
                            ${item.status === 'optimizing' ? 'bg-purple-50' : ''}
                            ${item.status === 'processing' ? 'bg-blue-50' : ''}
                            ${item.status === 'duplicate' ? 'bg-gray-100' : ''}
                            hover:bg-white`}
                        >
                          <span className={`truncate flex-1 font-medium ${item.status === 'failed' ? 'text-red-700' : 'text-gray-700'}`}>
                            {item.origFilename || item.filename}
                          </span>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {(item.status === 'processing' || item.status === 'optimizing') && (
                              <span className={`animate-spin inline-block h-3 w-3 border-2 rounded-full border-t-transparent
                                ${item.status === 'optimizing' ? 'border-purple-500' : 'border-blue-500'}`}
                              />
                            )}
                            {canRetry && (
                              <button
                                onClick={() => handleRetryItem(batch.batchId, item.index)}
                                disabled={retrying.has(itemKey)}
                                className="px-1.5 py-0.5 text-[10px] bg-red-50 text-red-700 hover:bg-red-100
                                           rounded border border-red-200 disabled:opacity-50"
                                title="Re-extract this image (1 AI call)"
                              >
                                {retrying.has(itemKey) ? '…' : '↻'}
                              </button>
                            )}
                            {statusDot(item.status, item.stage, item.message, item.errorCode)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ── Top-level render ──────────────────────────────────────────────────

  // Order batches: live ones first (uploading/processing), then most recent.
  const ordered = [...batches].sort((a, b) => {
    const liveOrder = (s: string) => (s === 'uploading' || s === 'processing') ? 0 : 1;
    const la = liveOrder(a.status), lb = liveOrder(b.status);
    if (la !== lb) return la - lb;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });

  const liveCount = batches.filter(b => b.status === 'uploading' || b.status === 'processing').length;
  const doneCountTotal = batches.filter(b => b.status === 'done').length;

  return (
    <div className="w-full p-4 sm:p-8">
      <div className="space-y-4 w-full max-w-3xl mx-auto">

        {/* ── New-scan form ── */}
        <div className="bg-white rounded-lg shadow-md p-4 sm:p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-800">📄 Scan Receipts</h2>
            {batches.length > 0 && (
              <span className="text-xs text-gray-500">
                {liveCount > 0 ? `${liveCount} in progress · ` : ''}
                {batches.length} total batch{batches.length !== 1 ? 'es' : ''}
              </span>
            )}
          </div>

          {uploadPhase ? (
            <div className="py-4 space-y-3">
              <div className="flex items-center gap-3 justify-center text-blue-600 font-medium text-sm">
                <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full" />
                {uploadPhase.totalChunks > 1
                  ? <>Uploading sub-batch {uploadPhase.chunkIndex + 1} of {uploadPhase.totalChunks} — {uploadPhase.totalFiles} files — {uploadPhase.percent}%</>
                  : <>Uploading {uploadPhase.totalFiles} files — {uploadPhase.percent}%</>}
              </div>
              <div className="w-full max-w-md mx-auto h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all duration-300 ease-out" style={{ width: `${uploadPhase.percent}%` }} />
              </div>
              <p className="text-center text-xs text-gray-400">
                Already-uploaded sub-batches are processing on the server.
                You'll see their progress below as soon as this upload finishes.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">🏷️ Batch Title</label>
                <input
                  type="text"
                  value={batchTitle}
                  onChange={e => { setBatchTitle(e.target.value); setFormError(''); }}
                  placeholder="e.g. June Market Run"
                  className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">📁 Select Images</label>
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={e => {
                    if (e.target.files) {
                      const files = Array.from(e.target.files);
                      setSelectedFiles(files);
                      setDuplicates(detectDuplicates(files));
                      setFormError('');
                    }
                  }}
                  className="block w-full text-sm text-gray-700
                    file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0
                    file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700
                    hover:file:bg-indigo-100"
                />
                <div className="flex justify-between items-center mt-1">
                  <p className="text-xs text-gray-500">
                    {selectedFiles.length > 0
                      ? `${selectedFiles.length} file(s) selected (${formatFileSize(totalSize)})`
                      : `Max upload size: ${MAX_UPLOAD_SIZE_MB}MB`}
                  </p>
                  {selectedFiles.length > 0 && (
                    <p className={`text-xs font-medium ${isOverLimit ? 'text-red-600' : 'text-gray-400'}`}>
                      {formatFileSize(totalSize)} / {MAX_UPLOAD_SIZE_MB}MB
                    </p>
                  )}
                </div>
                {isOverLimit && !willChunk && (
                  <p className="text-xs text-red-600 mt-1 font-semibold">
                    ⚠️ Selection exceeds {MAX_UPLOAD_SIZE_MB}MB limit. Please remove some files.
                  </p>
                )}
                {totalDupes > 0 && (
                  <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-amber-700 font-medium">
                        ⚠️ {totalDupes} duplicate file{totalDupes > 1 ? 's' : ''} detected
                      </span>
                      <button
                        onClick={() => {
                          const keep = new Map<string, File>();
                          for (const f of selectedFiles) {
                            const fp = fingerprint(f);
                            if (!keep.has(fp)) keep.set(fp, f);
                          }
                          setSelectedFiles(Array.from(keep.values()));
                          setDuplicates(new Map());
                        }}
                        className="px-2 py-0.5 bg-amber-200 text-amber-800 rounded hover:bg-amber-300 font-medium"
                      >
                        Remove duplicates
                      </button>
                    </div>
                  </div>
                )}
                {willChunk && selectedFiles.length > 0 && (
                  <p className="text-xs text-blue-600 mt-1">
                    ℹ️ {selectedFiles.length} files ({formatFileSize(totalSize)}) — will be split into {chunkCount} sub-batches.
                    Each appears as its own panel below.
                  </p>
                )}
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <button
                onClick={handleProcess}
                disabled={!batchTitle.trim() || selectedFiles.length === 0 || (isOverLimit && !willChunk)}
                className="w-full py-2 px-4 rounded-md text-white font-medium text-lg transition
                  bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
              >
                📤 Process Images
              </button>

              {doneCountTotal > 0 && (
                <button
                  onClick={() => { invalidate(); navigate('/receipts'); }}
                  className="w-full py-1.5 text-sm text-indigo-700 hover:underline"
                >
                  View Receipts from completed batches →
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── Active-batches stack ── */}
        {!loaded && (
          <div className="text-center text-sm text-gray-500 py-6">Loading batches…</div>
        )}
        {loaded && ordered.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-4">No active batches.</div>
        )}
        {ordered.map(renderBatchPanel)}
      </div>
    </div>
  );
};

export default ScannerPage;
