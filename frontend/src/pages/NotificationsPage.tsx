/**
 * NotificationsPage — durable, reviewable record of scan/batch failures.
 * Cleaner tabs by category (All / AI / Image / System), each sorted by date,
 * simple line topic; click opens reusable modal with full message + options.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { scanErrorApi, type ScanError } from '../services/api';
import { toast } from '../stores/toastStore';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import ScanErrorModal, { groupForCode } from '../components/ScanErrorModal';
import { Bell, CheckCheck, Inbox, Trash2, CircleAlert, CircleX, Info } from 'lucide-react';

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
  AI_RATE_LIMIT: 'AI rate-limited — will retry automatically.',
  AI_TIMEOUT: 'AI timed out — will retry.',
  AI_INVALID_JSON: 'AI returned malformed data — retrying per-image.',
  AI_EMPTY_RESPONSE: 'AI returned no data for this image.',
  AI_PROVIDER_ERROR: 'AI provider error — will retry.',
  NETWORK_ERROR: 'Network error — will retry.',
  SAVE_FAILED: 'Failed to save receipt to database.',
  IMAGE_INVALID: 'Image could not be read.',
  IMAGE_TOO_LARGE: 'Image is too large to process.',
  UNKNOWN: 'Unexpected error.',
};

function formatStamp(ts: number | null): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

type Tab = 'All' | 'AI' | 'Image' | 'System';
const TABS: Tab[] = ['All', 'AI', 'Image', 'System'];

const NotificationsPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<ScanError[]>([]);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('All');
  const [limit, setLimit] = useState(50);
  const [selected, setSelected] = useState<ScanError | null>(null);
  const { confirm, dialog: deleteDialog } = useConfirmDelete();

  const load = useCallback(async (lim: number) => {
    if (!userId) return;
    setLoading(true);
    try {
      const data = await scanErrorApi.list(lim);
      setErrors(data.errors);
      setUnread(data.errors.filter(e => !e.read).length);
    } catch {
      /* keep last known state */
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { if (userId) load(limit); }, [userId, load, limit]);

  const filtered = useMemo(() => {
    const sorted = [...errors].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
    if (activeTab === 'All') return sorted;
    return sorted.filter(e => groupForCode(e.code) === activeTab);
  }, [errors, activeTab]);

  const counts = useMemo(() => {
    const c: Record<Tab, { total: number; unread: number }> = { All: { total: 0, unread: 0 }, AI: { total: 0, unread: 0 }, Image: { total: 0, unread: 0 }, System: { total: 0, unread: 0 } };
    for (const e of errors) {
      c.All.total++; if (!e.read) c.All.unread++;
      const g = groupForCode(e.code);
      c[g].total++; if (!e.read) c[g].unread++;
    }
    return c;
  }, [errors]);

  const doMarkRead = async (id: string) => {
    try {
      await scanErrorApi.markRead(id);
      setErrors(prev => prev.map(e => (e.id === id ? { ...e, read: true } : e)));
      setUnread(prev => Math.max(0, prev - 1));
      if (selected?.id === id) setSelected({ ...selected, read: true });
    } catch { toast.error('Failed to update notification'); }
  };

  const doMarkAllRead = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await scanErrorApi.markAllRead();
      setErrors(prev => prev.map(e => ({ ...e, read: true })));
      setUnread(0);
      toast.success('All notifications marked as read');
    } catch { toast.error('Failed to update notifications'); } finally { setBusy(false); }
  };

  const doRemove = async (id: string) => {
    try {
      await scanErrorApi.remove(id);
      setErrors(prev => {
        const removed = prev.find(e => e.id === id);
        if (removed && !removed.read) setUnread(u => Math.max(0, u - 1));
        return prev.filter(e => e.id !== id);
      });
      if (selected?.id === id) setSelected(null);
    } catch { toast.error('Failed to dismiss notification'); }
  };

  const doClearAll = async () => {
    if (busy || errors.length === 0) return;
    if (!(await confirm({ title: 'Clear notification log?', message: 'Clear the entire notification log? This cannot be undone.' }))) return;
    setBusy(true);
    try {
      await scanErrorApi.clearAll();
      setErrors([]); setUnread(0); setSelected(null);
      toast.info('Notification log cleared');
    } catch { toast.error('Failed to clear notifications'); } finally { setBusy(false); }
  };

  const Icon = (e: ScanError) => CODE_ICONS[e.code] || CircleAlert;
  const iconColor = (e: ScanError) => (e.code === 'AI_QUOTA_EXCEEDED' || e.code === 'AI_AUTH_FAILED' || e.code === 'SAVE_FAILED') ? 'text-red-600' : 'text-amber-600';

  return (
    <div className="w-full p-4 sm:p-8">
      {deleteDialog}
      <ScanErrorModal
        open={!!selected}
        error={selected}
        onClose={() => setSelected(null)}
        onMarkRead={doMarkRead}
        onRemove={doRemove}
        onRetryDone={() => load(limit)}
      />
      <div className="space-y-4 w-full max-w-3xl mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-gray-600" />
            <h2 className="text-xl font-semibold text-gray-800">Notifications</h2>
            {unread > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-xs font-semibold">{unread} unread</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={doMarkAllRead} disabled={busy || unread === 0} className="px-3 py-1.5 text-sm border rounded text-gray-700 hover:bg-gray-50 disabled:opacity-40 inline-flex items-center gap-1.5"><CheckCheck className="h-4 w-4" /> Mark all read</button>
            <button onClick={doClearAll} disabled={busy || errors.length === 0} className="px-3 py-1.5 text-sm border rounded text-red-600 hover:bg-red-50 disabled:opacity-40 inline-flex items-center gap-1.5"><Trash2 className="h-4 w-4" /> Clear all</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${activeTab === tab ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {tab} <span className="ml-1 text-xs text-gray-400">{counts[tab].total}{counts[tab].unread ? ` · ${counts[tab].unread} new` : ''}</span>
            </button>
          ))}
        </div>

        {loading && <div className="text-center text-sm text-gray-500 py-10">Loading notifications…</div>}

        {!loading && filtered.length === 0 && (
          <div className="bg-white border rounded-lg shadow-sm p-10 text-center">
            <Inbox className="h-10 w-10 mx-auto text-gray-300" />
            <p className="mt-3 text-sm text-gray-500">No notifications in {activeTab}.</p>
            <p className="text-xs text-gray-400 mt-1">Failed scans will show up here.</p>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="bg-white border rounded-lg shadow-sm divide-y">
            {filtered.map(e => {
              const KindIcon = Icon(e);
              const short = e.message || EMPTY_LOOKUP[e.code] || '';
              return (
                <button
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition ${e.read ? '' : 'bg-red-50/40'}`}
                >
                  <KindIcon className={`h-4 w-4 flex-shrink-0 ${iconColor(e)}`} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm truncate ${e.read ? 'text-gray-700' : 'text-gray-900 font-semibold'}`}>
                      {e.title || 'Receipt batch'} <span className="font-normal text-gray-400">· {e.code}</span>
                      {!e.read && <span className="ml-2 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] border border-red-200 align-middle">NEW</span>}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{short}</p>
                  </div>
                  <span className="text-[11px] text-gray-400 flex-shrink-0">{formatStamp(e.created_at)}</span>
                </button>
              );
            })}
          </div>
        )}

        {!loading && errors.length >= limit && (
          <div className="text-center">
            <button onClick={() => setLimit(l => l + 50)} className="px-4 py-2 text-sm border rounded bg-white hover:bg-gray-50">Load more</button>
          </div>
        )}

        <p className="text-xs text-gray-400 text-center">Click a line to view full message and actions.</p>
      </div>
    </div>
  );
};

export default NotificationsPage;
