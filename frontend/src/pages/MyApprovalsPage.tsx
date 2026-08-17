// src/pages/MyApprovalsPage.tsx
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useScopeStore } from '../stores/scopeStore';
import {
  receiptStatusLabel,
  receiptStatusClass,
} from '../utils/receiptStatus';

type Tab = 'pending' | 'approved';

/**
 * User-facing document pipeline page.
 *
 * - Pending Approval: receipts awaiting an admin decision (Recall → back to
 *   review for editing, or View).
 * - Approved: finalized receipts — read-only, cannot be re-edited.
 */
const MyApprovalsPage = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const selfUid = user?.uid;
  const activeUid = useScopeStore((s) => s.activeUid);
  const isAdmin = !!user?.is_admin;

  // Operate on the admin's real account OR the selected scope for non-admin use.
  const effectiveUid = activeUid || selfUid;

  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<any[]>([]);
  const [approved, setApproved] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recallTarget, setRecallTarget] = useState<any | null>(null);

  const load = useCallback(async () => {
    if (!effectiveUid) return;
    setLoading(true);
    try {
      const [p, a] = await Promise.all([
        receiptApi.list(0, 1000, { status: 'pending_approval' }),
        receiptApi.list(0, 1000, { status: 'processed' }),
      ]);
      setItems(p.items || []);
      setApproved(a.items || []);
    } catch (e: any) {
      setError(e.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  }, [effectiveUid]);

  useEffect(() => {
    load();
  }, [load]);

  const confirmRecall = async () => {
    if (!recallTarget) return;
    setBusyId(recallTarget.id);
    try {
      await receiptApi.recall(effectiveUid!, recallTarget.id);
      setRecallTarget(null);
      await load();
    } catch (e: any) {
      setError(e.message || 'Recall failed');
    } finally {
      setBusyId(null);
    }
  };

  const TABS: { key: Tab; label: string }[] = [
    { key: 'pending', label: `Pending Approval (${items.length})` },
    { key: 'approved', label: `Approved (${approved.length})` },
  ];

  return (
    <div className="p-4 sm:p-6 w-full">
      <h1 className="text-xl font-semibold mb-4 text-gray-800">My Documents</h1>

      <div className="flex gap-1 mb-4 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
        </div>
      ) : (
        <>
          {tab === 'pending' && items.length === 0 && (
            <div className="bg-white rounded-lg shadow p-8 text-center">
              <div className="text-5xl mb-4">📨</div>
              <h2 className="text-xl font-bold text-gray-800 mb-1">Nothing pending approval</h2>
              <p className="text-gray-500 text-sm">Receipts you submit for approval will appear here.</p>
            </div>
          )}

          {tab === 'approved' && approved.length === 0 && (
            <div className="bg-white rounded-lg shadow p-8 text-center">
              <div className="text-5xl mb-4">✅</div>
              <h2 className="text-xl font-bold text-gray-800 mb-1">No approved documents yet</h2>
              <p className="text-gray-500 text-sm">Your approved receipts will be listed here.</p>
            </div>
          )}

          {((tab === 'pending' && items.length > 0) || (tab === 'approved' && approved.length > 0)) && (
            <div className="bg-white rounded-lg shadow overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs sm:text-sm">
                  <thead className="bg-gray-50 border-b text-left text-xs text-gray-500 uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2">Supplier</th>
                      <th className="px-3 py-2">Category</th>
                      <th className="px-3 py-2">Location</th>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Invoice #</th>
                      <th className="px-3 py-2 text-right">Tax</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Batch</th>
                      <th className="px-3 py-2 text-right">Items</th>
                      <th className="px-3 py-2">Scanned</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {(tab === 'pending' ? items : approved).map((r: any) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-3 py-2 font-medium">{r.supplier || '—'}</td>
                        <td className="px-3 py-2">{r.category || '—'}</td>
                        <td className="px-3 py-2">{r.location || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.receiptDate || r.receipt_date || '—'}</td>
                        <td className="px-3 py-2">{r.invoiceNumber || r.invoice_number || '—'}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          {r.taxAmount ?? r.tax_amount
                            ? `KES ${Number(r.taxAmount ?? r.tax_amount ?? 0).toLocaleString()}${r.taxRate ? ` (${r.taxRate}%)` : ''}`
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                          KES {Number(r.totalAmount ?? r.total_amount ?? 0).toLocaleString()}
                        </td>
                        <td className="px-3 py-2">{r.batchTitle || r.batch_title || '—'}</td>
                        <td className="px-3 py-2 text-right">{r.items?.length ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {r.scannedAt || r.scanned_at
                            ? new Date(r.scannedAt || r.scanned_at).toLocaleDateString()
                            : r.createdAt || r.created_at
                              ? new Date(r.createdAt || r.created_at).toLocaleDateString()
                              : '—'}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${receiptStatusClass(r.status)}`}>
                            {receiptStatusLabel(r.status)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1.5">
                            <button
                              onClick={() => navigate(`/receipts/${r.id}`)}
                              className="px-2 py-1 text-xs rounded border text-gray-600 hover:bg-gray-100"
                            >
                              View
                            </button>
                            {tab === 'pending' && (
                              <button
                                onClick={() => setRecallTarget(r)}
                                disabled={busyId === r.id}
                                className="px-2 py-1 text-xs rounded bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50"
                              >
                                Recall
                              </button>
                            )}
                            {tab === 'approved' && !isAdmin && (
                              <span className="inline-flex items-center px-2 py-1 text-xs text-gray-400">
                                Read-only
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <div className="mt-4 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-red-400 hover:text-red-600 font-medium"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Recall confirm modal (replaces browser confirm) ── */}
      {recallTarget && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Recall Receipt</h3>
            <p className="text-sm text-gray-600">
              Recall <strong>{recallTarget.supplier || 'this receipt'}</strong> back to review so you can edit it?
            </p>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setRecallTarget(null)}
                disabled={busyId === recallTarget.id}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmRecall}
                disabled={busyId === recallTarget.id}
                className="px-4 py-2 text-white bg-gray-600 rounded hover:bg-gray-700 disabled:opacity-50"
              >
                {busyId === recallTarget.id ? 'Recalling…' : 'Recall'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default MyApprovalsPage;
