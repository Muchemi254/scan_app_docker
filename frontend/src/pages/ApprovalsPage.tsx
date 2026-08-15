// src/pages/ApprovalsPage.tsx
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useScopeStore } from '../stores/scopeStore';
import {
  receiptStatusLabel,
  receiptStatusClass,
} from '../utils/receiptStatus';

/**
 * Admin-only global approval queue (cross-tenant).
 *
 * Lists every pending-approval receipt across all users and lets the admin
 * approve (→ processed) or reject (→ needs_review, with optional note).
 * "Open" jumps into that user's workspace (sets the active scope) and goes
 * to the receipts list so the admin can inspect/edit the full receipt.
 */
const ApprovalsPage = () => {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const setActiveUid = useScopeStore((s) => s.setActiveUid);
  const isAdmin = !!user?.is_admin;

  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await receiptApi.listPendingApproval();
      setItems(data.items || []);
      setTotal(data.total || 0);
    } catch (e: any) {
      alert(e.message || 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="p-6">
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">Admins only</h2>
          <p className="text-gray-500 text-sm">You need admin privileges to review approvals.</p>
        </div>
      </div>
    );
  }

  const approve = async (row: any) => {
    setBusyId(row.id);
    try {
      await receiptApi.approve(row.owner_uid, row.id);
      await load();
    } catch (e: any) {
      alert(e.message || 'Approval failed');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (row: any) => {
    const note = window.prompt('Reason for rejection (optional):', '') ?? null;
    if (note === undefined) return; // cancelled
    setBusyId(row.id);
    try {
      await receiptApi.reject(row.owner_uid, row.id, note || undefined);
      await load();
    } catch (e: any) {
      alert(e.message || 'Rejection failed');
    } finally {
      setBusyId(null);
    }
  };

  const openInScope = (row: any) => {
    setActiveUid(row.owner_uid);
    navigate('/receipts');
  };

  return (
    <div className="p-4 sm:p-6 w-full">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-gray-800">Approvals</h1>
        <span className="text-sm text-gray-500">{total} pending</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="inline-block animate-spin rounded-full h-10 w-10 border-4 border-blue-500 border-t-transparent" />
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-gray-800 mb-1">Nothing to approve</h2>
          <p className="text-gray-500 text-sm">No receipts are awaiting approval.</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b text-left text-xs text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((row: any) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <span className="font-medium">{row.owner_display_name || row.owner_email || row.owner_uid}</span>
                  </td>
                  <td className="px-3 py-2">{row.supplier || '—'}</td>
                  <td className="px-3 py-2">{row.receipt_date || '—'}</td>
                  <td className="px-3 py-2 text-right font-medium">
                    KES {Number(row.total_amount || 0).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${receiptStatusClass(row.status)}`}>
                      {receiptStatusLabel(row.status)}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => openInScope(row)}
                        className="px-2 py-1 text-xs rounded border text-gray-600 hover:bg-gray-100"
                        title="Open in this user's workspace"
                      >
                        Open
                      </button>
                      <button
                        onClick={() => reject(row)}
                        disabled={busyId === row.id}
                        className="px-2 py-1 text-xs rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => approve(row)}
                        disabled={busyId === row.id}
                        className="px-2 py-1 text-xs rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        Approve
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default ApprovalsPage;
