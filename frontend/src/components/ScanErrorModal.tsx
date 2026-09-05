import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ExternalLink, RefreshCw, CheckCheck, Trash2, Copy } from 'lucide-react';
import type { ScanError } from '../services/api';
import { batchApi } from '../services/api';
import { toast } from '../stores/toastStore';

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

function formatStamp(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export const groupForCode = (code: string): 'AI' | 'Image' | 'System' => {
  if (code.startsWith('AI_') || code === 'NETWORK_ERROR') return 'AI';
  if (code.startsWith('IMAGE_')) return 'Image';
  return 'System';
};

interface Props {
  error: ScanError | null;
  open: boolean;
  onClose: () => void;
  onMarkRead?: (id: string) => void;
  onRemove?: (id: string) => void;
  onRetryDone?: () => void;
}

export default function ScanErrorModal({ error, open, onClose, onMarkRead, onRemove, onRetryDone }: Props) {
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);

  if (!open || !error) return null;

  const canRetry = !['AI_QUOTA_EXCEEDED', 'AI_AUTH_FAILED'].includes(error.code);
  const items: any[] = Array.isArray(error.data?.items) ? error.data.items : [];
  const chunkIdx: number | undefined = error.data?.chunk_index;
  const isSingle = items.length === 1 && typeof items[0]?.index === 'number';
  const isMulti = items.length > 1 || (typeof chunkIdx === 'number' && items.length !== 1);

  const handleRetrySingle = async () => {
    if (!error.batch_id || !canRetry) return;
    setRetrying(true);
    try {
      if (typeof chunkIdx === 'number' && !isSingle) {
        // chunk retry (multiple items but single chunk) — do directly in modal for single chunk
        // but spec: if multiple files -> retry in Scan, so navigate
        navigate(`/scans?batchId=${error.batch_id}`);
        onClose();
        return;
      }
      if (isSingle) {
        await batchApi.retryItem(error.batch_id, items[0].index);
        toast.success('Retry queued', 'Image re-processing');
        onRetryDone?.();
        onClose();
      } else if (typeof chunkIdx === 'number') {
        await batchApi.retryChunk(error.batch_id, chunkIdx);
        toast.success('Retry queued', `Chunk ${chunkIdx + 1} re-processing`);
        onRetryDone?.();
        onClose();
      } else {
        navigate(`/scans?batchId=${error.batch_id}`);
        onClose();
      }
    } catch (e: any) {
      toast.error('Retry failed', e?.message ?? 'Please try again');
    } finally {
      setRetrying(false);
    }
  };

  const handleGoScan = () => {
    if (error.batch_id) navigate(`/scans?batchId=${error.batch_id}`);
    else navigate('/scans');
    onClose();
  };

  const copyBatch = async () => {
    if (!error.batch_id) return;
    try { await navigator.clipboard.writeText(error.batch_id); toast.success('Copied', error.batch_id.slice(0, 8)); } catch {}
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-lg shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b bg-gray-50">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 truncate">{error.title || 'Receipt batch'}</h3>
            <p className="text-xs text-gray-500 mt-0.5">{error.code} · {formatStamp(error.created_at)}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-500"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-sm text-gray-800 break-words">
            <span className="font-semibold">{error.code}</span>{' — '}{error.message || ERROR_MESSAGES[error.code] || 'Unexpected error.'}
          </div>
          {error.batch_id && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span className="font-medium">Batch:</span>
              <span className="font-mono">{error.batch_id.slice(0, 8)}</span>
              <button onClick={copyBatch} className="p-1 rounded hover:bg-gray-100"><Copy className="h-3 w-3" /></button>
              <span className="text-gray-400">· {error.kind}</span>
            </div>
          )}
          {items.length > 0 && (
            <div className="border rounded overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 border-b text-xs font-semibold text-gray-700">
                Affected files ({items.length}) {typeof chunkIdx === 'number' && `· Chunk ${chunkIdx + 1}`}
              </div>
              <ul className="max-h-48 overflow-y-auto divide-y text-xs">
                {items.map((it: any, i: number) => (
                  <li key={i} className="px-3 py-1.5 flex items-center justify-between gap-2">
                    <span className="truncate text-gray-700">{it.filename || `item ${it.index ?? i}`}</span>
                    {it.code && <span className="text-[10px] font-medium text-red-600 flex-shrink-0">{it.code}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!error.read && <p className="text-[11px] text-amber-700">Unread — will stay until marked read or dismissed.</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 px-5 py-3 border-t bg-gray-50">
          {onMarkRead && !error.read && (
            <button onClick={() => onMarkRead(error.id)} className="px-3 py-1.5 text-xs border rounded bg-white hover:bg-gray-100">Mark read</button>
          )}
          <button onClick={handleGoScan} className="px-3 py-1.5 text-xs border rounded bg-white hover:bg-gray-100 inline-flex items-center gap-1.5">
            <ExternalLink className="h-3.5 w-3.5" /> Open in Scans
          </button>
          {canRetry && error.batch_id && (
            isMulti ? (
              <button onClick={handleGoScan} className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 inline-flex items-center gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" /> Retry in Scans
              </button>
            ) : (
              <button onClick={handleRetrySingle} disabled={retrying} className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 inline-flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" /> {retrying ? 'Retrying…' : 'Retry'}
              </button>
            )
          )}
          {onRemove && (
            <button onClick={() => { onRemove(error.id); onClose(); }} className="px-3 py-1.5 text-xs border rounded text-red-600 hover:bg-red-50 inline-flex items-center gap-1"><Trash2 className="h-3.5 w-3.5" /> Dismiss</button>
          )}
          <button onClick={onClose} className="px-3 py-1.5 text-xs bg-gray-800 text-white rounded hover:bg-gray-900">Close</button>
        </div>
      </div>
    </div>
  );
}
