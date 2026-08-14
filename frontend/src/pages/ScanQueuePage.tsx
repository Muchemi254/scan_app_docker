/**
 * ScanQueuePage — manage held (prepared) scans and monitor dispatched work.
 *
 * Lists every durable scan session for the user. Prepared sessions show
 * groups with per-group "Send to AI" buttons; processing/done/failed sessions
 * show live progress with retry/dismiss/review. Because sessions live in
 * Postgres, held work from days or weeks ago still shows up here, ready to
 * be dispatched — no re-upload, no re-processing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BatchPanel, { type Batch } from '../components/BatchPanel';
import { batchApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import { toast } from '../stores/toastStore';

const POLL_INTERVAL_MS = 2000;

const ScanQueuePage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const { invalidate } = useReceiptStore();

  const [batches, setBatches] = useState<Batch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!userId) return;
    try {
      const list: Batch[] = await batchApi.listActive();
      setBatches(list);
    } catch {
      /* polling is best-effort; keep last-known state */
    } finally {
      setLoaded(true);
    }
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    setLoaded(false);
    refresh();
  }, [userId, refresh]);

  // Poll while any session is live (uploading / processing). Prepared
  // sessions are static until the user dispatches them, so no polling needed.
  useEffect(() => {
    if (!userId) return;
    const anyLive = batches.some(b => b.status === 'uploading' || b.status === 'processing');
    if (!anyLive) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [userId, batches, refresh]);

  // Invalidate the receipt store when a batch transitions to done.
  const prevDone = useRef(0);
  useEffect(() => {
    const doneNow = batches.filter(b => b.status === 'done').length;
    if (doneNow > prevDone.current) invalidate();
    prevDone.current = doneNow;
  }, [batches, invalidate]);

  const handleDismiss = async (batchId: string) => {
    try { await batchApi.dismiss(batchId); } catch { /* best-effort */ }
    setBatches(prev => prev.filter(b => b.batchId !== batchId));
  };

  const handleRetryChunk = async (batchId: string, chunkIndex: number) => {
    try {
      await batchApi.retryChunk(batchId, chunkIndex);
      await refresh();
      toast.info('Chunk retry queued', 'This chunk will re-process on the server.');
    } catch (e: any) {
      toast.error('Retry chunk failed', e?.message ?? 'Please try again.');
    }
  };

  const handleRetryItem = async (batchId: string, itemIndex: number) => {
    try {
      await batchApi.retryItem(batchId, itemIndex);
      await refresh();
      toast.info('Item retry queued', 'This image will re-extract on the server.');
    } catch (e: any) {
      toast.error('Retry failed', e?.message ?? 'Please try again.');
    }
  };

  const preparedCount = batches.filter(b => b.status === 'prepared').length;
  const liveCount = batches.filter(b => b.status === 'uploading' || b.status === 'processing').length;

  const ordered = [...batches].sort((a, b) => {
    const liveOrder = (s: string) => (s === 'uploading' || s === 'processing') ? 0 : (s === 'prepared' ? 1 : 2);
    const la = liveOrder(a.status), lb = liveOrder(b.status);
    if (la !== lb) return la - lb;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });

  return (
    <div className="w-full p-4 sm:p-8">
      <div className="space-y-4 w-full max-w-3xl mx-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">🗂️ Scans</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {preparedCount > 0
                ? `${preparedCount} session${preparedCount !== 1 ? 's' : ''} held — dispatch when ready.`
                : liveCount > 0
                  ? `${liveCount} processing now.`
                  : 'No held scans. Upload in Scanner, then dispatch groups here.'}
            </p>
          </div>
          <button
            onClick={() => navigate('/scanner')}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm"
          >
            + New scan
          </button>
        </div>

        {!loaded && (
          <div className="text-center text-sm text-gray-500 py-6">Loading scans…</div>
        )}
        {loaded && ordered.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-10 border border-dashed rounded-lg bg-white">
            Nothing here yet.<br />
            Go to <button onClick={() => navigate('/scanner')} className="text-indigo-600 hover:underline font-medium">Scanner</button> to upload and prepare images, then come back to send them to AI.
          </div>
        )}
        {ordered.map(batch => (
          <BatchPanel
            key={batch.batchId}
            batch={batch}
            onDismiss={handleDismiss}
            onGoReview={() => { invalidate(); navigate('/review'); }}
            onChanged={refresh}
            onRetryChunk={handleRetryChunk}
            onRetryItem={handleRetryItem}
          />
        ))}
      </div>
    </div>
  );
};

export default ScanQueuePage;
