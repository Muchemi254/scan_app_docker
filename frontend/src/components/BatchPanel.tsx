/**
 * BatchPanel — renders one scan session.
 *
 * Shows three sections:
 *  1. Ready-to-send: held images grouped into cards with per-group "Send to
 *     AI" buttons + "Send all". This section stays visible whenever held
 *     (`prepared`) images remain, even while another group is processing, so
 *     users can send the next batch without hunting for hidden buttons.
 *  2. Progress / results: live chunk-grouped items while processing, and
 *     saved / review / failed summaries once finished.
 *  3. Review / retry / dismiss actions.
 *
 * Every send is a two-step confirm (exact count), and Dismiss (which
 * permanently deletes the session's photos + data) requires typing DELETE.
 *
 * Used by both ScannerPage (active work) and ScanQueuePage (management).
 */

import { useState } from 'react';
import { toast } from '../stores/toastStore';
import { batchApi } from '../services/api';

export type ItemStatus = 'pending' | 'optimizing' | 'prepared' | 'processing' | 'done' | 'needs_review' | 'failed' | 'duplicate';
type ItemStage = 'queued' | 'optimizing' | 'extracting' | 'parsing' | 'saving' | 'done';
type ChunkStatus = 'pending' | 'extracting' | 'saving' | 'done' | 'failed';
export type BatchStatus = 'uploading' | 'prepared' | 'processing' | 'done' | 'failed';

export interface BatchItem {
  index: number;
  filename: string;
  origFilename?: string | null;
  mime?: string | null;
  sha256?: string | null;
  status: ItemStatus;
  stage?: ItemStage;
  chunkIndex?: number | null;
  groupIndex?: number | null;
  receiptId: string | null;
  message: string | null;
  errorCode?: string | null;
}

export interface BatchChunk {
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

export interface Batch {
  batchId: string;
  userId: string;
  batchTitle: string;
  status: BatchStatus;
  createdAt: number;
  imageCount?: number;
  groupCount?: number;
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

const HARD_FAIL_CODES = new Set(['AI_QUOTA_EXCEEDED', 'AI_AUTH_FAILED']);

interface DispatchOpts { groups?: number[]; items?: number[]; all?: boolean; }

interface BatchPanelProps {
  batch: Batch;
  onDismiss: (batchId: string) => void;
  onGoReview: () => void;
  onChanged?: () => void;               // parent re-fetches the list (e.g. after dispatch)
  onRetryChunk?: (batchId: string, chunkIndex: number) => Promise<void>;
  onRetryItem?: (batchId: string, itemIndex: number) => Promise<void>;
}

const BatchPanel = ({
  batch, onDismiss, onGoReview, onChanged,
  onRetryChunk, onRetryItem,
}: BatchPanelProps) => {
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState<Set<string>>(new Set());
  const [pendingSend, setPendingSend] = useState<{ label: string; opts: DispatchOpts } | null>(null);
  const [showDismiss, setShowDismiss] = useState(false);
  const [dismissText, setDismissText] = useState('');

  const handleRetryChunk = async (chunkIndex: number) => {
    if (!onRetryChunk) return;
    const key = `${batch.batchId}:c${chunkIndex}`;
    setRetrying(prev => new Set(prev).add(key));
    try {
      await onRetryChunk(batch.batchId, chunkIndex);
    } finally {
      setRetrying(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleRetryItem = async (itemIndex: number) => {
    if (!onRetryItem) return;
    const key = `${batch.batchId}:i${itemIndex}`;
    setRetrying(prev => new Set(prev).add(key));
    try {
      await onRetryItem(batch.batchId, itemIndex);
    } finally {
      setRetrying(prev => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const handleDispatch = async (opts: DispatchOpts) => {
    const key = JSON.stringify(opts);
    setDispatching(prev => new Set(prev).add(key));
    try {
      const res = await batchApi.dispatch(batch.batchId, opts);
      toast.info('AI scan started', `${res.dispatched ?? 0} image(s) sent to AI.`);
      onChanged?.();
    } catch (e: any) {
      toast.error('Dispatch failed', e?.message ?? 'Please try again.');
    } finally {
      setDispatching(prev => { const n = new Set(prev); n.delete(key); return n; });
      setPendingSend(null);
    }
  };

  const askSend = (label: string, opts: DispatchOpts) => setPendingSend({ label, opts });
  const askAll = () => askSend(`send all ${preparedCount}`, { all: true });

  // ── Counts ──────────────────────────────────────────────────────────────
  const preparedCount = batch.items.filter(i => i.status === 'prepared').length;
  const doneCount = batch.items.filter(i => i.status === 'done').length;
  const reviewCount = batch.items.filter(i => i.status === 'needs_review').length;
  const failedCount = batch.items.filter(i => i.status === 'failed').length;
  const duplicateCount = batch.items.filter(i => i.status === 'duplicate').length;
  const optimizingCount = batch.items.filter(i => i.status === 'optimizing').length;
  const processingCount = batch.items.filter(i => i.status === 'processing').length;
  const totalCount = batch.items.length;
  const finishedCount = doneCount + reviewCount + failedCount + duplicateCount;
  const isLive = batch.status === 'uploading' || batch.status === 'processing';
  const hasHeld = preparedCount > 0;
  const anyOriginal = preparedCount + doneCount + reviewCount + failedCount + duplicateCount > 0;

  const groupCount = hasHeld
    ? Math.max(batch.groupCount ?? 0, ...batch.items.map(i => (i.groupIndex ?? 0) + 1))
    : 0;

  const groups = hasHeld
    ? Array.from({ length: groupCount }, (_, g) => {
        const items = batch.items.filter(i => (i.groupIndex ?? 0) === g);
        return {
          index: g,
          items,
          prepared: items.filter(i => i.status === 'prepared').length,
        };
      }).filter(g => g.items.length > 0)
    : [];

  const statusDot = (s: ItemStatus, stage: ItemStage | undefined, message: string | null, errorCode?: string | null) => {
    const map: Record<ItemStatus, string> = {
      pending: 'text-gray-400', optimizing: 'text-purple-500', processing: 'text-blue-500',
      prepared: 'text-purple-600', done: 'text-green-600', needs_review: 'text-yellow-600',
      failed: 'text-red-600', duplicate: 'text-gray-500',
    };
    const icons: Record<ItemStatus, string> = {
      pending: '⏳', optimizing: '⚙️', processing: '🤖', prepared: '⏸',
      done: '✅', needs_review: '⚠️', failed: '❌', duplicate: '🔁',
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
      pending: ['bg-gray-100 text-gray-600', '⏳ Queued'],
      extracting: ['bg-blue-100 text-blue-700', '🤖 Extracting'],
      saving: ['bg-indigo-100 text-indigo-700', '💾 Saving'],
      done: ['bg-green-100 text-green-700', '✅ Done'],
      failed: ['bg-red-100 text-red-700', '❌ Failed'],
    };
    const [cls, label] = map[status];
    return <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{label}</span>;
  };

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
    batch.status === 'done' ? <span className="text-xs text-green-600 font-medium">✅ Complete</span> :
    batch.status === 'failed' ? <span className="text-xs text-red-600 font-medium">❌ Failed</span> :
    batch.status === 'processing' ? <span className="flex items-center gap-1.5 text-xs text-blue-600">
        <span className="animate-spin inline-block h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full" />
        Processing…
      </span> :
    batch.status === 'prepared' ? <span className="text-xs text-purple-600 font-medium">⏸ Ready to send</span> :
    <span className="text-xs text-gray-500">⏳ Uploading…</span>;

  const confirming = pendingSend ? dispatching.has(JSON.stringify(pendingSend.opts)) : false;

  return (
    <div key={batch.batchId} className="bg-white border rounded-lg shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b bg-gray-50">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-semibold text-gray-800 truncate">{batch.batchTitle}</span>
          {headerBadge}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!isLive && reviewCount > 0 && (
            <button
              onClick={onGoReview}
              className="px-2 py-1 text-xs bg-yellow-500 text-white rounded hover:bg-yellow-600"
            >
              Review {reviewCount}
            </button>
          )}
          <button
            onClick={() => setShowDismiss(true)}
            className="px-2 py-1 text-xs border rounded text-gray-600 hover:bg-gray-100"
          >
            Dismiss
          </button>
        </div>
      </div>

      <div className="p-3 space-y-3">
        {/* Ready-to-send section — stays visible while held groups remain */}
        {hasHeld && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-[10px] sm:text-xs text-gray-500">
              <div className="flex flex-col border-l-2 border-purple-500 pl-2">
                <span className="text-purple-600 font-bold uppercase tracking-wider">Ready to send</span>
                <span>{preparedCount}</span>
              </div>
              <div className="flex flex-col border-l-2 border-gray-400 pl-2">
                <span className="text-gray-600 font-bold uppercase tracking-wider">Duplicates</span>
                <span>{duplicateCount}</span>
              </div>
              <div className="flex flex-col border-l-2 border-red-500 pl-2">
                <span className="text-red-600 font-bold uppercase tracking-wider">Failed prep</span>
                <span>{failedCount}</span>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              These images are stored locally and ready. Sending runs AI processing
              on exactly the photos you choose — the rest stay saved and unsent.
            </p>

            <div className="space-y-2">
              {groups.length === 0 ? (
                <div className="text-xs text-gray-500 italic">Grouping images…</div>
              ) : groups.map(g => (
                <div key={g.index} className="flex items-center justify-between gap-2 border rounded px-3 py-2 bg-gray-50">
                  <div className="min-w-0">
                    <span className="text-sm font-semibold text-gray-700">
                      {g.prepared === g.items.length
                        ? `${g.items.length} photos`
                        : `${g.prepared} of ${g.items.length} photos ready`}
                    </span>
                    {g.prepared < g.items.length && (
                      <span className="text-xs text-gray-500 ml-2">
                        {g.items.length - g.prepared} already done
                      </span>
                    )}
                  </div>
                  {g.prepared > 0 && (
                    <button
                      onClick={() => askSend(`${g.prepared} photo${g.prepared !== 1 ? 's' : ''}`, { groups: [g.index] })}
                      disabled={dispatching.has(JSON.stringify({ groups: [g.index] }))}
                      className="px-3 py-1 text-xs bg-indigo-600 text-white hover:bg-indigo-700 rounded disabled:opacity-50"
                    >
                      {dispatching.has(JSON.stringify({ groups: [g.index] })) ? 'Sending…' : `▶ Send ${g.prepared}`}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <button
              onClick={askAll}
              disabled={dispatching.has('{"all":true}')}
              className="w-full py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {dispatching.has('{"all":true}') ? 'Sending…' : `▶ Send all ${preparedCount} to AI`}
            </button>
          </div>
        )}

        {/* Progress / results section */}
        {(isLive || finishedCount > 0) && (
          <>
            {totalCount > 0 && (
              <div className="space-y-1">
                <div className="flex justify-between text-[10px] text-gray-400 font-medium px-1">
                  <span>Progress</span>
                  <span>{Math.round((finishedCount / totalCount) * 100)}% ({finishedCount}/{totalCount})</span>
                </div>
                <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden border">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-indigo-600 transition-all duration-500"
                    style={{ width: `${totalCount ? (finishedCount / totalCount) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}

            {anyOriginal && (
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
                            onClick={() => handleRetryChunk(chunkMeta.index)}
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
                                ${item.status === 'prepared' ? 'bg-purple-50' : ''}
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
                                    onClick={() => handleRetryItem(item.index)}
                                    disabled={retrying.has(itemKey)}
                                    className="px-1.5 py-0.5 text-[10px] bg-red-50 text-red-700 hover:bg-red-100 rounded border border-red-200 disabled:opacity-50"
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
            )}

            {failedCount > 0 && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded p-2">
                {failedCount} image(s) failed. Retry individual images (↻) or retry a failed chunk.
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirm-send modal */}
      {pendingSend && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-gray-800">Send to AI</h3>
            <p className="text-sm text-gray-600">
              Send <span className="font-semibold">{pendingSend.label}</span> to AI for processing?
              Only these photos will be processed; the rest stay saved and unsent.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingSend(null)}
                disabled={confirming}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDispatch(pendingSend.opts)}
                disabled={confirming}
                className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
              >
                {confirming ? 'Sending…' : `Send ${pendingSend.label}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dismiss confirm modal (type DELETE) */}
      {showDismiss && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-lg shadow-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-red-700">Dismiss this scan?</h3>
            <p className="text-sm text-gray-600">
              This permanently deletes this session's photos and data. This cannot be undone.
              Type <span className="font-mono font-semibold">DELETE</span> to confirm.
            </p>
            <input
              autoFocus
              value={dismissText}
              onChange={e => setDismissText(e.target.value)}
              placeholder="DELETE"
              className="w-full px-3 py-2 text-sm border rounded focus:outline-none focus:ring-2 focus:ring-red-400"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowDismiss(false); setDismissText(''); }}
                className="px-3 py-1.5 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowDismiss(false); setDismissText('');
                  onDismiss(batch.batchId);
                }}
                disabled={dismissText.trim() !== 'DELETE'}
                className="px-3 py-1.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BatchPanel;
