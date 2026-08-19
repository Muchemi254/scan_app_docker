/**
 * NotificationsPage — durable, reviewable record of scan/batch failures.
 *
 * The scanner shows live errors while a batch is still on screen, but the
 * live view expires with the 24h-batch. This page lists the persistent
 * scan_errors log written by the worker so users can see — more than once —
 * exactly what failed (quota/auth/save, which batch, which items) and react.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  scanErrorApi,
  type ScanError,
} from '../services/api';
import { toast } from '../stores/toastStore';
import {
  Bell, CheckCheck, Inbox, ListChecks, Trash2,
  CircleAlert, CircleX, Info,
} from 'lucide-react';

const CODE_ICONS: Record<string, typeof CircleAlert> = {
  AI_QUOTA_EXCEEDED: CircleAlert,
  AI_AUTH_FAILED: CircleX,
  SAVE_FAILED: CircleX,
  AI_EMPTY_RESPONSE: Info,
  AI_TIMEOUT: Info,
  AI_RATE_LIMIT: Info,
  AI_PROVIDER_ERROR: Info,
  NETWORK_ERROR: Info,
};

const EMPTY_LOOKUP: Record<string, string> = {
  AI_QUOTA_EXCEEDED: 'AI quota exhausted — check your API plan.',
  AI_AUTH_FAILED: 'AI API key was rejected — update it in Settings.',
  AI_RATE_LIMIT: 'AI rate-limited — retried automatically.',
  AI_TIMEOUT: 'AI timed out.',
  AI_INVALID_JSON: 'AI returned malformed data.',
  AI_EMPTY_RESPONSE: 'AI returned no data for this image.',
  AI_PROVIDER_ERROR: 'AI provider error.',
  NETWORK_ERROR: 'Network error.',
  SAVE_FAILED: 'Failed to save receipt to database.',
  IMAGE_INVALID: 'Image could not be read.',
  IMAGE_TOO_LARGE: 'Image is too large to process.',
  UNKNOWN: 'Unexpected error.',
};

function formatStamp(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const NotificationsPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<ScanError[]>([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const data = await scanErrorApi.list(100);
      setErrors(data.errors);
      setUnread(data.errors.filter(e => !e.read).length);
    } catch {
      /* keep last known state */
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (userId) load();
  }, [userId, load]);

  const doMarkRead = async (id: string) => {
    try {
      await scanErrorApi.markRead(id);
      setErrors(prev => prev.map(e => (e.id === id ? { ...e, read: true } : e)));
      setUnread(prev => Math.max(0, prev - 1));
    } catch {
      toast.error('Failed to update notification');
    }
  };

  const doMarkAllRead = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await scanErrorApi.markAllRead();
      setErrors(prev => prev.map(e => ({ ...e, read: true })));
      setUnread(0);
      toast.success('All notifications marked as read');
    } catch {
      toast.error('Failed to update notifications');
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (id: string) => {
    try {
      await scanErrorApi.remove(id);
      setErrors(prev => {
        const removed = prev.find(e => e.id === id);
        if (removed && !removed.read) setUnread(u => Math.max(0, u - 1));
        return prev.filter(e => e.id !== id);
      });
    } catch {
      toast.error('Failed to dismiss notification');
    }
  };

  const doClearAll = async () => {
    if (busy || errors.length === 0) return;
    if (!window.confirm('Clear the entire notification log?')) return;
    setBusy(true);
    try {
      await scanErrorApi.clearAll();
      setErrors([]);
      setUnread(0);
      toast.info('Notification log cleared');
    } catch {
      toast.error('Failed to clear notifications');
    } finally {
      setBusy(false);
    }
  };

  const Icon = (e: ScanError) => CODE_ICONS[e.code] || CircleAlert;
  const iconColor = (e: ScanError) => {
    if (e.code === 'AI_QUOTA_EXCEEDED' || e.code === 'AI_AUTH_FAILED' || e.code === 'SAVE_FAILED')
      return 'text-red-600';
    return 'text-amber-600';
  };

  return (
    <div className="w-full p-4 sm:p-8">
      <div className="space-y-4 w-full max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-gray-600" />
            <h2 className="text-xl font-semibold text-gray-800">Notifications</h2>
            {unread > 0 && (
              <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-semibold">
                {unread} unread
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={doMarkAllRead}
              disabled={busy || unread === 0}
              className="px-3 py-1.5 text-sm border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <CheckCheck className="h-4 w-4" /> Mark all read
            </button>
            <button
              onClick={doClearAll}
              disabled={busy || errors.length === 0}
              className="px-3 py-1.5 text-sm border rounded text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              <Trash2 className="h-4 w-4" /> Clear all
            </button>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          These are scanning and AI errors that{" "}
          <span className="font-medium">left the batch screen</span> but where the work failed.
          Review them here, dismiss when resolved.
        </p>

        {/* List */}
        {loading && <div className="text-center text-sm text-gray-500 py-10">Loading notifications…</div>}

        {!loading && errors.length === 0 && (
          <div className="bg-white border rounded-lg shadow-sm p-10 text-center">
            <Inbox className="h-10 w-10 mx-auto text-gray-300" />
            <p className="mt-3 text-sm text-gray-500">No notifications yet.</p>
            <p className="text-xs text-gray-400 mt-1">Failed scans will show up here.</p>
          </div>
        )}

        {!loading && errors.map(e => {
          const KindIcon = Icon(e);
          const itemsFailed = (e.data?.items && Array.isArray(e.data.items)) ? e.data.items.length : 0;
          return (
            <div
              key={e.id}
              className={`bg-white border rounded-lg shadow-sm p-4 ${
                e.read ? 'border-gray-200' : 'border-red-200'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <KindIcon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${iconColor(e)}`} />
                  <div className="min-w-0">
                    <p className={`text-sm font-medium text-gray-900 flex items-center gap-2 flex-wrap ${e.read ? '' : 'font-semibold'}`}>
                      <span className="truncate">{e.title || 'Receipt batch'}</span>
                      {!e.read && (
                        <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 text-[10px] font-semibold border border-red-200">
                          NEW
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-700 mt-1 break-words">
                      <span className="font-semibold">{e.code}</span>
                      {e.message ? ` — ${e.message}` : EMPTY_LOOKUP[e.code] ? ` — ${EMPTY_LOOKUP[e.code]}` : ''}
                    </p>
                    {itemsFailed > 0 && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        {itemsFailed} item{itemsFailed > 1 ? 's' : ''} failed · chunk{' '}
                        {e.data.chunk_index !== undefined ? e.data.chunk_index + 1 : '—'}
                      </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-1">
                      {formatStamp(e.created_at)}
                      {e.batch_id ? ` · batch ${e.batch_id.slice(0, 8)}` : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => navigate('/scanner')}
                    title="Go to scanner to retry / re-scan"
                    className="p-1.5 rounded text-gray-500 hover:bg-gray-100 transition"
                  >
                    <ListChecks className="h-4 w-4" />
                  </button>
                  {!e.read && (
                    <button
                      onClick={() => doMarkRead(e.id)}
                      title="Mark as read"
                      className="p-1.5 rounded text-gray-500 hover:bg-gray-100 transition"
                    >
                      <CheckCheck className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={() => doRemove(e.id)}
                    title="Dismiss"
                    className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {e.data?.items && Array.isArray(e.data.items) && e.data.items.length > 0 && (
                <div className="mt-2 pl-8">
                  <details className="text-xs">
                    <summary className="text-gray-500 cursor-pointer hover:text-gray-700">
                      Affected files ({e.data.items.length})
                    </summary>
                    <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                      {e.data.items.map((it: any, i: number) => (
                        <li key={i} className="text-gray-600 flex items-center justify-between gap-2">
                          <span className="truncate">{it.filename || `item ${it.index ?? i}`}</span>
                          {it.code && (
                            <span className="text-[10px] text-red-600 font-medium flex-shrink-0">
                              {it.code}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
              {e.code === 'SAVE_FAILED' && (
                <p className="mt-2 pl-8 text-[11px] text-amber-700">
                  Saved then failed? This receipt may already be stored — check{" "}
                  <button onClick={() => navigate('/receipts')} className="underline hover:text-amber-800">Receipts</button>{" "}
                  before re-scanning to avoid a duplicate.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default NotificationsPage;