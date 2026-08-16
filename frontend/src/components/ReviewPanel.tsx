import { useState, useEffect } from 'react';
import { receiptApi, locationsApi, settingsApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import ReceiptForm from './ReceiptForm';
import AuditTrail from './AuditTrail';

import type { ReceiptData } from '../types/gemini';
import ImageViewer from './ImageViewer';
import { parseCurrencyToNumber } from '../utils/helpers';
import { receiptStatusLabel, receiptStatusClass } from '../utils/receiptStatus';

const ReviewPanel = ({
  userId,
  receipt,
  setIsEditing,
  isAdmin = false,
  onSaved,
  onDeleted,
}: {
  userId: string;
  receipt: ReceiptData;
  setIsEditing: (v: boolean) => void;
  isAdmin?: boolean;
  onSaved?: (updated: any) => void;
  onDeleted?: (id: string) => void;
}) => {
  const { upsert, remove } = useReceiptStore();
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [newImage, setNewImage] = useState<File | null>(null);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [defaultTaxRate, setDefaultTaxRate] = useState(16);

  // Reference data + the user's personal tax default for the editor.
  useEffect(() => {
    locationsApi.list().then((r) => setLocations(r.items)).catch(() => {});
    settingsApi.getTaxPreference().then((r) => setDefaultTaxRate(r.default_tax_rate)).catch(() => {});
  }, []);

  // Reset editing state when the selected receipt changes
  useEffect(() => {
    setEditing(false);
    setNewImage(null);
  }, [receipt.id]);

  useEffect(() => {
    setIsEditing(editing);
  }, [editing, setIsEditing]);

  const handleSelectRequest = (newId: string) => {
    if (editing) {
      setPendingId(newId);
      setShowUnsavedModal(true);
    } else {
      // Logic for changing receipt - this depends on parent container's state handling
      // For now, simple console log as parent needs to know
      console.log('Change to:', newId);
    }
  };

  const confirmDiscard = () => {
    if (pendingId) {
      setEditing(false);
      // Parent component would handle this via prop or store
      console.log('Discarding and switching to:', pendingId);
      setPendingId(null);
    }
    setShowUnsavedModal(false);
  };

  const doUpdate = async (data: any) => {
    if (!receipt.id) return;
    try {
      setLoading(true);
      const updated = await receiptApi.update(receipt.id, data, newImage || undefined);
      upsert(updated);
      setEditing(false);
      setNewImage(null);
      onSaved?.(updated);
    } catch (error) {
      console.error('Update failed', error);
      alert(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (updatedData: any) => {
    if (!receipt.id) return;
    await doUpdate(updatedData);
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this receipt?')) return;
    if (!receipt.id) return;
    try {
      setLoading(true);
      await receiptApi.delete(receipt.id);
      remove(receipt.id);
      onDeleted?.(receipt.id);
    } catch (error) {
      console.error('Delete failed', error);
      alert(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setLoading(false);
    }
  };

  // ── Review → approval workflow actions (pending_approval items) ─────────
  const runWorkflowAction = async (fn: () => Promise<any>, success?: string) => {
    if (!receipt.id) return;
    try {
      setActionLoading(true);
      const updated = await fn();
      upsert(updated);
      if (success) alert(success);
      onSaved?.(updated);
    } catch (error) {
      console.error('Workflow action failed', error);
      alert(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const isApproved = receipt.status === 'processed';
  const readOnly = isApproved && !isAdmin;

  const handleRecall = () =>
    runWorkflowAction(() => receiptApi.recall(userId, receipt.id!));

  const handleApprove = () =>
    runWorkflowAction(() => receiptApi.approve(userId, receipt.id!), 'Receipt approved.');

  const handleReject = () => {
    const note = window.prompt('Reason for rejection (optional):', '') ?? null;
    if (note === undefined) return; // cancelled
    return runWorkflowAction(
      () => receiptApi.reject(userId, receipt.id!, note || undefined),
      'Receipt rejected.'
    );
  };

  const imageUrl = newImage ? URL.createObjectURL(newImage) : receipt.imageUrl;

  return (
    <div className="h-full flex flex-col bg-white">
      {showUnsavedModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Unsaved Changes</h3>
            <p className="text-gray-600 text-sm">You have unsaved changes. Are you sure you want to discard them?</p>
            <div className="flex justify-end gap-3 pt-2">
              <button 
                onClick={() => setShowUnsavedModal(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
              >
                Continue Editing
              </button>
              <button 
                onClick={confirmDiscard}
                className="px-4 py-2 text-white bg-red-600 rounded hover:bg-red-700"
              >
                Discard Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header bar ── */}
      <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b bg-white sticky top-0 z-10">
        <h2 className="font-semibold text-sm sm:text-base truncate text-gray-800">
          {receipt.supplier || 'Receipt'}
        </h2>
        <div className="flex gap-2 flex-shrink-0 flex-wrap justify-end">
          {!editing && receipt.status === 'pending_approval' && (
            <>
              <button
                onClick={handleRecall}
                disabled={actionLoading}
                className="px-3 py-1.5 text-xs sm:text-sm rounded font-medium bg-gray-600 text-white hover:bg-gray-700 disabled:opacity-50"
                title={isAdmin ? 'Return to needs-review' : 'Withdraw your submission for editing'}
              >
                {actionLoading ? '…' : 'Recall'}
              </button>
              {isAdmin && (
                <>
                  <button
                    onClick={handleReject}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-xs sm:text-sm rounded font-medium bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                  >
                    {actionLoading ? '…' : 'Reject'}
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={actionLoading}
                    className="px-3 py-1.5 text-xs sm:text-sm rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {actionLoading ? '…' : 'Approve'}
                  </button>
                </>
              )}
            </>
          )}
          {!readOnly && (
            <button
              onClick={() => setEditing(prev => !prev)}
              disabled={loading || actionLoading}
              className={`px-3 py-1.5 text-xs sm:text-sm rounded font-medium transition-colors disabled:opacity-50 ${
                editing
                  ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  : 'bg-blue-500 text-white hover:bg-blue-600'
              }`}
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
          )}
          {!readOnly && (
            <button
              onClick={handleDelete}
              disabled={loading || actionLoading}
              className="px-3 py-1.5 text-xs sm:text-sm rounded font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {loading && !editing ? '…' : 'Delete'}
            </button>
          )}
          {readOnly && (
            <span className="self-center text-xs text-gray-500 italic">Read-only (approved)</span>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">
        {editing ? (
          /* ── Edit mode: form + image side by side on lg ── */
          <div className="flex flex-col lg:flex-row lg:h-full">
            {/* Image — sticky on mobile so it stays visible when keyboard opens */}
            {imageUrl && (
              <div className="sticky top-0 z-10 lg:static lg:w-1/2 xl:w-[55%] flex-shrink-0 border-b lg:border-b-0 lg:border-l order-first lg:order-last bg-gray-50 flex flex-col">
                <div className="flex-shrink-0 px-3 pt-2 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  Receipt Image
                </div>
                <div className="p-2 lg:flex-1">
                  <ImageViewer
                    imageUrl={imageUrl}
                    altText="Receipt"
                    containerClass="h-36 sm:h-48 lg:h-full lg:min-h-[50vh]"
                  />
                </div>
              </div>
            )}

            {/* Form — scrollable */}
            <div className={`flex-1 min-w-0 overflow-y-auto p-4 ${!imageUrl ? 'w-full' : ''}`}>
              <ReceiptForm
                initialData={receipt}
                onSubmit={handleUpdate}
                onImageChange={setNewImage}
                loading={loading}
                isAdmin={isAdmin}
                locations={locations}
                defaultTaxRate={defaultTaxRate}
              />
            </div>
          </div>
        ) : (
          /* ── View mode ── */
          <div className="p-4 space-y-3 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
              {[
                ['Supplier', receipt.supplier],
                ['Total', receipt.totalAmount],
                ['Tax', receipt.taxAmount],
                ['Date', receipt.receiptDate],
                ['Category', receipt.category],
                ['Location', receipt.location],
                ...(receipt.taxRate != null && receipt.taxRate !== ''
                  ? [['Tax Rate', `${receipt.taxRate}%`] as [string, string]]
                  : []),
                ['Status', receiptStatusLabel(receipt.status)],
                ['Invoice #', receipt.invoiceNumber],
                ['KRA PIN', receipt.kraPin],
                ['CU Invoice', receipt.cuInvoice],
                ['Batch', receipt.batchTitle],
              ]
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <dt className="font-medium text-gray-500 w-24 flex-shrink-0">{label}:</dt>
                    <dd className="text-gray-800 break-words">{value}</dd>
                  </div>
                ))}
            </dl>

            {receipt.items && receipt.items.length > 0 && (
              <div className="mt-4">
                <h4 className="font-semibold text-gray-700 mb-2">Items</h4>
                <div className="overflow-x-auto rounded border">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-2 py-1.5">Name</th>
                        <th className="text-right px-2 py-1.5">Qty</th>
                        <th className="text-right px-2 py-1.5">Price</th>
                        <th className="text-right px-2 py-1.5">Tax</th>
                        <th className="text-right px-2 py-1.5">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {receipt.items.map((item: any, i: number) => {
                        const qty = Number(item.quantity) || 0;
                        const price = parseCurrencyToNumber(item.price);
                        const tax = parseCurrencyToNumber(item.tax);
                        return (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="px-2 py-1.5">{item.name}</td>
                            <td className="text-right px-2 py-1.5">{qty}</td>
                            <td className="text-right px-2 py-1.5">{price.toFixed(2)}</td>
                            <td className="text-right px-2 py-1.5">{tax.toFixed(2)}</td>
                            <td className="text-right px-2 py-1.5 font-medium">
                              {(qty * (price + tax)).toFixed(2)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {receipt.imageUrl && (
              <div className="mt-4">
                <h4 className="font-semibold text-gray-700 mb-2">Receipt Image</h4>
                <ImageViewer
                  imageUrl={receipt.imageUrl}
                  altText="Receipt"
                  containerClass="h-56 sm:h-80 md:h-96"
                />
              </div>
            )}

            {receipt.id && (
              <div className="mt-6">
                <AuditTrail receiptId={receipt.id} />
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
};

export default ReviewPanel;
