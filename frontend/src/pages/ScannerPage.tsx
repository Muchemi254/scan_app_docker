/**
 * ScannerPage — backend-driven batch scanning.
 *
 * Processing runs entirely on the server:
 *  - Hard refresh or navigation away does NOT interrupt scanning.
 *  - On return, the page reconnects to the in-progress batch via batchId
 *    stored in localStorage.
 *
 * State machine:
 *   idle → uploading → processing → done / failed
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { batchApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';

// ─── Types ────────────────────────────────────────────────────────────────

type ItemStatus = 'pending' | 'processing' | 'done' | 'needs_review' | 'failed';

interface BatchItem {
  index: number;
  filename: string;
  status: ItemStatus;
  receiptId: string | null;
  message: string | null;
}

interface Batch {
  batchId: string;
  userId: string;
  batchTitle: string;
  status: 'uploading' | 'processing' | 'done' | 'failed';
  createdAt: number;
  items: BatchItem[];
}

// ─── localStorage helpers ─────────────────────────────────────────────────

const lsKey = (userId: string) => `scan-batch-${userId}`;

function saveBatchId(userId: string, batchId: string) {
  localStorage.setItem(lsKey(userId), batchId);
}

function loadBatchId(userId: string): string | null {
  return localStorage.getItem(lsKey(userId));
}

function clearBatchId(userId: string) {
  localStorage.removeItem(lsKey(userId));
}

// ─── Component ────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const MAX_UPLOAD_SIZE_MB = 500;

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

  // Page-level state
  const [batch, setBatch] = useState<Batch | null>(null);
  const [activeBatches, setActiveBatches] = useState<Batch[]>([]);
  const [pageStatus, setPageStatus] = useState<
    'idle' | 'reconnecting' | 'uploading' | 'processing' | 'done' | 'failed'
  >('idle');
  const [uploadProgress, setUploadProgress] = useState(0);

  // New-scan form state
  const [batchTitle, setBatchTitle] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState('');

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
  const isOverLimit = totalSize > MAX_UPLOAD_SIZE_MB * 1024 * 1024;

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── On mount: check for an active batch in localStorage ──────────────

  useEffect(() => {
    if (!userId) return;

    const savedId = loadBatchId(userId);
    
    setPageStatus('reconnecting');
    
    // Fetch all active batches from server
    batchApi.listActive()
      .then(batches => {
        setActiveBatches(batches);
        
        // If we have a local ID, find it in the server list
        if (savedId) {
          const current = batches.find(b => b.batchId === savedId);
          if (current) {
            setBatch(current);
            setPageStatus(current.status === 'processing' || current.status === 'uploading' ? 'processing' : current.status);
          } else {
            // Local ID not found on server (expired/deleted)
            clearBatchId(userId);
            // Check if there are ANY other active batches to show instead
            if (batches.length > 0) {
              const latest = batches[0];
              setBatch(latest);
              saveBatchId(userId, latest.batchId);
              setPageStatus(latest.status === 'processing' || latest.status === 'uploading' ? 'processing' : latest.status);
            } else {
              setPageStatus('idle');
            }
          }
        } else if (batches.length > 0) {
          // No local ID, but server has active batches. Show the most recent one.
          const latest = batches[0];
          setBatch(latest);
          saveBatchId(userId, latest.batchId);
          setPageStatus(latest.status === 'processing' || latest.status === 'uploading' ? 'processing' : latest.status);
        } else {
          setPageStatus('idle');
        }
      })
      .catch(() => {
        setPageStatus('idle');
      });
  }, [userId, invalidate]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Polling: while processing, refresh batch status every 2 s ────────

  useEffect(() => {
    if (pageStatus !== 'processing' || !userId) {
      stopPolling();
      return;
    }

    pollRef.current = setInterval(async () => {
      if (!batch?.batchId) return;
      try {
        const updated: Batch = await batchApi.status(batch.batchId);
        setBatch(updated);
        if (updated.status === 'done') {
          stopPolling();
          setPageStatus('done');
          invalidate();
        } else if (updated.status === 'failed') {
          stopPolling();
          setPageStatus('failed');
        }
      } catch {
        // transient network error — keep polling
      }
    }, POLL_INTERVAL_MS);

    return stopPolling;
  }, [pageStatus, batch?.batchId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // ── Start a new scan ──────────────────────────────────────────────────

  const handleProcess = async () => {
    if (!userId) return;
    if (!batchTitle.trim()) { setFormError('Enter a batch title.'); return; }
    if (selectedFiles.length === 0) { setFormError('Select at least one image.'); return; }
    setFormError('');

    try {
      // 1. Create batch record → get batchId
      setPageStatus('uploading');
      setUploadProgress(0);
      const { batchId } = await batchApi.create(
        batchTitle.trim(),
        selectedFiles.map(f => f.name),
      );

      // 2. Store batchId immediately so refresh can reconnect
      saveBatchId(userId, batchId);

      // 3. Upload files and start backend processing
      try {
        await batchApi.process(batchId, selectedFiles, (percent) => {
          setUploadProgress(percent);
        });
      } catch (uploadErr: any) {
        // IMPORTANT: Notify backend that upload failed so other devices don't get stuck
        await batchApi.dismiss(batchId).catch(() => {}); 
        throw uploadErr;
      }

      // 4. Fetch initial state and start polling

      const initial: Batch = await batchApi.status(batchId);
      setBatch(initial);
      setPageStatus('processing');
    } catch (err: any) {
      setFormError(err.message ?? 'Failed to start batch — please try again.');
      setPageStatus('idle');
    }
  };

  // ── Dismiss a finished batch ──────────────────────────────────────────

  const handleDismiss = async () => {
    if (!userId || !batch) return;
    try {
      await batchApi.dismiss(batch.batchId);
    } catch {
      // best-effort
    }
    clearBatchId(userId);
    setBatch(null);
    setBatchTitle('');
    setSelectedFiles([]);
    setPageStatus('idle');
  };

  // ── Helpers ───────────────────────────────────────────────────────────

  const doneCount = batch?.items.filter(i => i.status === 'done').length ?? 0;
  const reviewCount = batch?.items.filter(i => i.status === 'needs_review').length ?? 0;
  const failedCount = batch?.items.filter(i => i.status === 'failed').length ?? 0;
  const totalCount = batch?.items.length ?? 0;

  const statusDot = (s: ItemStatus, message: string | null) => {
    const map: Record<ItemStatus, string> = {
      pending: 'text-gray-400',
      processing: 'text-blue-500',
      done: 'text-green-600',
      needs_review: 'text-yellow-600',
      failed: 'text-red-600',
    };
    const icons: Record<ItemStatus, string> = {
      pending: '⏳',
      processing: '⏳',
      done: '✅',
      needs_review: '⚠️',
      failed: '❌',
    };
    return (
      <div className="flex flex-col items-end">
        <span className={`text-xs font-semibold ${map[s]}`}>{icons[s]} {s.replace('_', ' ')}</span>
        {message && (
          <span className="text-[10px] text-gray-400 mt-0.5 max-w-[120px] truncate text-right">
            {message}
          </span>
        )}
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="w-full p-4 sm:p-8">
      <div className="bg-white rounded-lg shadow-md p-4 sm:p-8 w-full max-w-3xl mx-auto">

        {/* ── Header ── */}
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold text-gray-800">📄 Scan Receipts</h2>
          {(pageStatus === 'done' || pageStatus === 'failed') && (
            <button
              onClick={handleDismiss}
              className="px-3 py-1 text-sm bg-gray-500 text-white rounded hover:bg-gray-600"
            >
              New Scan
            </button>
          )}
        </div>

        {/* ── Reconnecting spinner ── */}
        {pageStatus === 'reconnecting' && (
          <div className="flex items-center gap-3 py-8 justify-center text-gray-500">
            <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full" />
            Reconnecting to batch…
          </div>
        )}

        {/* ── Idle: new scan form ── */}
        {pageStatus === 'idle' && (
          <div className="space-y-4">
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
                    setSelectedFiles(Array.from(e.target.files));
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
                    : `Max upload size: ${MAX_UPLOAD_SIZE_MB}MB`
                  }
                </p>
                {selectedFiles.length > 0 && (
                  <p className={`text-xs font-medium ${isOverLimit ? 'text-red-600' : 'text-gray-400'}`}>
                    {formatFileSize(totalSize)} / {MAX_UPLOAD_SIZE_MB}MB
                  </p>
                )}
              </div>
              {isOverLimit && (
                <p className="text-xs text-red-600 mt-1 font-semibold">
                  ⚠️ Selection exceeds {MAX_UPLOAD_SIZE_MB}MB limit. Please remove some files.
                </p>
              )}
            </div>

            {formError && <p className="text-sm text-red-600">{formError}</p>}

            <button
              onClick={handleProcess}
              disabled={!batchTitle.trim() || selectedFiles.length === 0 || isOverLimit}
              className="w-full py-2 px-4 rounded-md text-white font-medium text-lg transition
                bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
            >
              📤 Process Images
            </button>
          </div>
        )}

        {/* ── Uploading ── */}
        {pageStatus === 'uploading' && (
          <div className="py-8 space-y-4">
            <div className="flex items-center gap-3 justify-center text-blue-600 font-medium">
              <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full" />
              Uploading {selectedFiles.length} image(s)… {uploadProgress}%
            </div>
            
            <div className="w-full max-w-md mx-auto h-2.5 bg-gray-100 rounded-full overflow-hidden">
              <div 
                className="h-full bg-blue-500 transition-all duration-300 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-center text-xs text-gray-400">
              Please don't close this tab until the upload is complete.
            </p>
          </div>
        )}

        {/* ── Processing / Done / Failed: batch status ── */}
        {batch && pageStatus !== 'idle' && pageStatus !== 'reconnecting' && pageStatus !== 'uploading' && (
          <div className="space-y-4">
            {/* Summary bar */}
            <div className="flex flex-wrap gap-3 items-center">
              <span className="font-semibold text-gray-700 truncate">{batch.batchTitle}</span>
              {pageStatus === 'processing' && (
                <span className="flex items-center gap-1.5 text-sm text-blue-600">
                  <span className="animate-spin inline-block h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full" />
                  Processing…
                </span>
              )}
              {pageStatus === 'done' && (
                <span className="text-sm text-green-600 font-medium">✅ Complete</span>
              )}
              {pageStatus === 'failed' && (
                <span className="text-sm text-red-600 font-medium">❌ Failed</span>
              )}
            </div>

            {/* Progress counts */}
            <div className="flex gap-4 text-xs text-gray-500">
              <span className="text-green-600 font-medium">{doneCount} done</span>
              <span className="text-yellow-600 font-medium">{reviewCount} need review</span>
              {failedCount > 0 && <span className="text-red-600 font-medium">{failedCount} failed</span>}
              <span>{totalCount} total</span>
            </div>

            {/* Progress bar */}
            {totalCount > 0 && (
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-500"
                  style={{ width: `${((doneCount + reviewCount + failedCount) / totalCount) * 100}%` }}
                />
              </div>
            )}

            {/* Item list */}
            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {batch.items.map(item => (
                <div
                  key={item.index}
                  className="flex items-center justify-between gap-3 border rounded px-3 py-2 bg-gray-50 text-sm hover:bg-white transition-colors"
                >
                  <span className="truncate flex-1 text-gray-700 font-medium">{item.filename}</span>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.status === 'processing' && (
                      <span className="animate-spin inline-block h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full" />
                    )}
                    {statusDot(item.status, item.message)}
                  </div>
                </div>
              ))}
            </div>

            {/* Actions when done */}
            {(pageStatus === 'done' || pageStatus === 'failed') && (
              <div className="flex flex-wrap gap-3 pt-2">
                <button
                  onClick={() => { invalidate(); navigate('/receipts'); }}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
                >
                  View Receipts
                </button>
                {reviewCount > 0 && (
                  <button
                    onClick={() => { invalidate(); navigate('/review'); }}
                    className="px-4 py-2 bg-yellow-500 text-white rounded hover:bg-yellow-600 text-sm"
                  >
                    Review {reviewCount} item{reviewCount !== 1 ? 's' : ''}
                  </button>
                )}
                <button
                  onClick={handleDismiss}
                  className="px-4 py-2 border rounded text-gray-600 hover:bg-gray-50 text-sm"
                >
                  New Scan
                </button>
              </div>
            )}

            {/* Info banner while processing */}
            {pageStatus === 'processing' && (
              <p className="text-xs text-gray-400 border-t pt-3">
                Processing runs on the server — you can navigate away or refresh this page and come back.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ScannerPage;
