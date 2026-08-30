import { useState, useEffect } from 'react';
import { receiptApi, locationsApi, settingsApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import ReceiptForm from './ReceiptForm';
import AuditTrail from './AuditTrail';

import type { ReceiptData } from '../types/gemini';
import { entryTypeLabel } from '../types/gemini';
import ImageViewer from './ImageViewer';
import { parseCurrencyToNumber } from '../utils/helpers';
import { lineTotalOf, sumItemTotals } from '../utils/itemTotals';
import { receiptStatusLabel } from '../utils/receiptStatus';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { toast } from '../stores/toastStore';

/* Shared read-only summary of a receipt (used by the main panel and the
   approve modal so both always show identical data). */
const fmtDate = (v?: string | null): string => {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
};

const ReceiptSummary = ({ data, showImage = true }: { data: ReceiptData; showImage?: boolean }) => (
  <div className="space-y-3 text-sm">
    {data.entryType && data.entryType !== 'expense' && (
      <div className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800">
        Non-expense — {entryTypeLabel(data.entryType)}. Excluded from totals and exports.
      </div>
    )}
    {data.fileType === 'application/pdf' && (
      <div className="rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
        📄 PDF receipt{data.pdfPageCount ? ` · ${data.pdfPageCount} page${data.pdfPageCount === 1 ? '' : 's'}` : ''} — all pages are one document
      </div>
    )}
    {showImage && data.imageUrl && (
      <div>
        <ImageViewer
          imageUrl={data.imageUrl}
          altText="Receipt"
          containerClass="h-44 sm:h-60"
          fileType={data.fileType}
        />
      </div>
    )}

    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
      {([
        ['Supplier', data.supplier],
        ['Total', data.totalAmount],
        ['Tax', data.taxAmount],
        ['Date', data.receiptDate],
        ['Scanned', fmtDate(data.scannedAt)],
        ['Category', data.category],
        ['Entry Type', entryTypeLabel(data.entryType)],
        ['Location', data.location],
        ...(data.taxRate != null && data.taxRate !== ''
          ? ([['Tax Rate', `${data.taxRate}%`]] as [string, string][])
          : []),
        ['Status', receiptStatusLabel(data.status)],
        ['Invoice #', data.invoiceNumber],
        ['KRA PIN', data.kraPin],
        ['Buyer PIN', data.buyerKraPin],
        ['CU Invoice', data.cuInvoice],
        ['Batch', data.batchTitle],
        ['Created', fmtDate(data.createdAt)],
        ['Updated', fmtDate(data.updatedAt)],
        ['ID', data.id],
      ] as [string, string][])
        .filter(([, v]) => v)
        .map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="font-medium text-gray-500 w-24 flex-shrink-0">{label}:</dt>
            <dd
              className={`break-words ${
                label === 'ID'
                  ? 'font-mono text-xs text-gray-500 truncate'
                  : 'text-gray-800'
              }`}
            >
              {value}
            </dd>
          </div>
        ))}
    </dl>

    {data.items && data.items.length > 0 && (
      <div className="mt-4">
        <h4 className="font-semibold text-gray-700 mb-2">Items ({data.items.length})</h4>
        <div className="overflow-x-auto rounded border">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-2 py-1.5">Name</th>
                <th className="text-right px-2 py-1.5">Qty</th>
                <th className="text-right px-2 py-1.5">Price</th>
                <th className="text-right px-2 py-1.5">Tax</th>
                <th className="text-right px-2 py-1.5">Disc.</th>
                <th className="text-right px-2 py-1.5">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.items.map((item: any, i: number) => {
                const qty = Number(item.quantity) || 0;
                const price = parseCurrencyToNumber(item.price);
                const tax = parseCurrencyToNumber(item.tax);
                const rate =
                  item.taxRate != null && item.taxRate !== '' ? `${item.taxRate}%` : '';
                return (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-2 py-1.5">
                      <span>{item.name}</span>
                      {(item.isZeroRated || rate) && (
                        <span className="ml-1 text-[10px] text-gray-500">
                          {item.isZeroRated ? '· 0-rated' : `· ${rate}`}
                        </span>
                      )}
                    </td>
                    <td className="text-right px-2 py-1.5">{qty}</td>
                    <td className="text-right px-2 py-1.5">{price.toFixed(2)}</td>
                    <td className="text-right px-2 py-1.5">{tax.toFixed(2)}</td>
                    <td className="text-right px-2 py-1.5">
                      {item.discount ? `${item.discount}%` : '—'}
                    </td>
                    <td className="text-right px-2 py-1.5 font-medium">
                      {lineTotalOf(item).toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {(() => {
              const totals = sumItemTotals(data.items);
              return (
                <tfoot className="border-t-2 border-gray-300 bg-gray-50">
                  <tr className="text-xs font-semibold text-gray-700">
                    <td colSpan={3} className="px-2 py-1.5 text-right">Totals</td>
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums">{totals.tax.toFixed(2)}</td>
                    <td />
                    <td className="text-right px-2 py-1.5 font-mono tabular-nums">{totals.total.toFixed(2)}</td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>
        </div>
      </div>
    )}
  </div>
);

const ReviewPanel = ({
  userId,
  receipt,
  setIsEditing,
  isAdmin = false,
  onSaved,
  onDeleted,
  useStore = true,
}: {
  userId: string;
  receipt: ReceiptData;
  setIsEditing: (v: boolean) => void;
  isAdmin?: boolean;
  onSaved?: (updated: any) => void;
  onDeleted?: (id: string) => void;
  /** Skip writes to the shared in-memory receipt store (used by the admin
   *  approval center, where receipts belong to another user's tenant). */
  useStore?: boolean;
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

  // Approval-action modals (replace slow browser alert/prompt/confirm)
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveMode, setApproveMode] = useState<'view' | 'edit'>('view');
  const [approveDraft, setApproveDraft] = useState<ReceiptData | null>(null);
  const [approveDraftImage, setApproveDraftImage] = useState<File | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const { confirm, dialog: deleteDialog } = useConfirmDelete();

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
      const updated = await receiptApi.update(receipt.id, data, newImage || undefined, userId);
      if (useStore) upsert(updated);
      setEditing(false);
      setNewImage(null);
      onSaved?.(updated);
    } catch (error) {
      console.error('Update failed', error);
      setActionError(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (updatedData: any) => {
    if (!receipt.id) return;
    await doUpdate(updatedData);
  };

  const handleDelete = async () => {
    if (!receipt.id) return;
    if (!(await confirm({
      title: 'Delete receipt?',
      message: (
        <>
          Delete <strong>{receipt.supplier || 'this receipt'}</strong>? This cannot be undone.
        </>
      ),
    }))) return;
    try {
      setLoading(true);
      await receiptApi.delete(receipt.id, userId);
      if (useStore) remove(receipt.id);
      toast.success('Receipt deleted', receipt.supplier || 'The receipt was removed.');
      onDeleted?.(receipt.id);
    } catch (error) {
      console.error('Delete failed', error);
      setActionError(error instanceof Error ? error.message : 'Delete failed');
      toast.error('Delete failed', error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  // ── Review → approval workflow actions (pending_approval items) ─────────
  const runWorkflowAction = async (fn: () => Promise<any>) => {
    if (!receipt.id) return;
    try {
      setActionLoading(true);
      const updated = await fn();
      if (useStore) upsert(updated);
      onSaved?.(updated);
    } catch (error) {
      console.error('Workflow action failed', error);
      setActionError(error instanceof Error ? error.message : 'Action failed');
    } finally {
      setActionLoading(false);
    }
  };

  const isApproved = receipt.status === 'processed';
  const readOnly = isApproved && !isAdmin;

  const handleRecall = () =>
    runWorkflowAction(() => receiptApi.recall(userId, receipt.id!));

  // Approve: open the confirm modal (view of the receipt + edit/cancel) instead of a slow alert
  const handleApprove = () => {
    setActionError(null);
    setApproveDraft(receipt);
    setApproveDraftImage(null);
    setApproveMode('view');
    setApproveOpen(true);
  };

  const confirmApprove = async () => {
    if (!receipt.id) return;
    setActionError(null);
    try {
      setActionLoading(true);
      const updated = await receiptApi.approve(userId, receipt.id);
      if (useStore) upsert(updated);
      setApproveOpen(false);
      onSaved?.(updated);
    } catch (error) {
      console.error('Approve failed', error);
      setActionError(error instanceof Error ? error.message : 'Approve failed');
    } finally {
      setActionLoading(false);
    }
  };

  // Save the in-modal edit, then return to the modal's view mode (still unapproved)
  const saveApproveDraft = async (data: any) => {
    if (!receipt.id) return;
    setActionError(null);
    try {
      setLoading(true);
      const updated = await receiptApi.update(
        receipt.id, data, approveDraftImage || undefined, userId
      );
      setApproveDraft(updated);
      setApproveDraftImage(null);
      setApproveMode('view');
      onSaved?.(updated);
    } catch (error) {
      console.error('Draft update failed', error);
      setActionError(error instanceof Error ? error.message : 'Update failed');
    } finally {
      setLoading(false);
    }
  };

  const handleReject = () => {
    setActionError(null);
    setRejectNote('');
    setRejectOpen(true);
  };

  const confirmReject = async () => {
    if (!receipt.id) return;
    setActionError(null);
    try {
      setActionLoading(true);
      const updated = await receiptApi.reject(userId, receipt.id, rejectNote || undefined);
      if (useStore) upsert(updated);
      setRejectOpen(false);
      onSaved?.(updated);
    } catch (error) {
      console.error('Reject failed', error);
      setActionError(error instanceof Error ? error.message : 'Reject failed');
    } finally {
      setActionLoading(false);
    }
  };

  const imageUrl = newImage ? URL.createObjectURL(newImage) : receipt.imageUrl;

  return (
    <div className="h-full flex flex-col bg-white">
      {deleteDialog}
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

      {/* ── Approve confirm modal: receipt view + edit (in-modal) + cancel ── */}
      {approveOpen && approveDraft && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-2 sm:p-4">
          <div
            className={`bg-white rounded-lg shadow-xl w-full flex flex-col ${
              approveMode === 'edit'
                ? 'max-w-2xl lg:max-w-[95vw] xl:max-w-6xl 2xl:max-w-7xl max-h-[92vh] lg:h-[92vh]'
                : 'max-w-3xl max-h-[90vh]'
            }`}
          >
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b">
              <div className="min-w-0">
                <h3 className="font-semibold text-gray-900">
                  {approveMode === 'edit' ? 'Edit Receipt' : 'Approve Receipt'}
                </h3>
                <p className="text-xs text-gray-500 truncate mt-0.5">
                  {approveDraft.supplier || 'Receipt'} ·{' '}
                  {approveDraft.location || 'no location'} ·{' '}
                  {approveDraft.receiptDate || 'no date'} · KES{' '}
                  {Number(approveDraft.totalAmount || 0).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => setApproveOpen(false)}
                disabled={loading || actionLoading}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none flex-shrink-0"
                title="Close"
              >×</button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {approveMode === 'edit' ? (
                <div className="flex flex-col lg:flex-row lg:h-full gap-4">
                  {(approveDraftImage ? URL.createObjectURL(approveDraftImage) : approveDraft.imageUrl) && (
                    <div className="lg:w-[45%] xl:w-[40%] flex-shrink-0 border rounded bg-gray-50 flex flex-col">
                      <div className="flex-shrink-0 px-3 pt-2 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        Receipt Image
                      </div>
                      <div className="p-2 flex-1">
                        <ImageViewer
                          imageUrl={approveDraftImage ? URL.createObjectURL(approveDraftImage) : (approveDraft.imageUrl || '')}
                          altText="Receipt"
                          containerClass="h-40 sm:h-56 lg:h-full lg:min-h-[50vh]"
                          fileType={approveDraftImage ? undefined : approveDraft.fileType}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 overflow-y-auto">
                    <ReceiptForm
                      initialData={approveDraft}
                      onSubmit={saveApproveDraft}
                      onImageChange={setApproveDraftImage}
                      loading={loading}
                      isAdmin={isAdmin}
                      locations={locations}
                      defaultTaxRate={defaultTaxRate}
                    />
                  </div>
                </div>
              ) : (
                <ReceiptSummary data={approveDraft} />
              )}
            </div>

            {actionError && (
              <div className="flex-shrink-0 px-4 py-2 bg-red-50 border-t border-red-200 text-sm text-red-700">
                {actionError}
              </div>
            )}

            <div className="flex-shrink-0 flex justify-end gap-2 px-4 py-3 border-t bg-gray-50">
              {approveMode === 'edit' ? (
                <button
                  onClick={() => setApproveMode('view')}
                  disabled={loading}
                  className="px-4 py-2 text-sm rounded font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
                >
                  Cancel Edit
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setApproveMode('edit')}
                    disabled={loading || actionLoading}
                    className="px-4 py-2 text-sm rounded font-medium bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => setApproveOpen(false)}
                    disabled={loading || actionLoading}
                    className="px-4 py-2 text-sm rounded font-medium bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={confirmApprove}
                    disabled={loading || actionLoading}
                    className="px-4 py-2 text-sm rounded font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    {actionLoading ? 'Approving…' : 'Approve'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Reject modal: optional reason (replaces browser prompt) ── */}
      {rejectOpen && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-4">
            <h3 className="text-lg font-bold text-gray-900">Reject Receipt</h3>
            <p className="text-sm text-gray-600">
              {receipt.supplier || 'Receipt'} · KES {Number(receipt.totalAmount || 0).toLocaleString()}
            </p>
            <textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              placeholder="Reason for rejection (optional)"
              rows={3}
              className="w-full px-3 py-2 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            {actionError && (
              <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                {actionError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setRejectOpen(false)}
                disabled={actionLoading}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmReject}
                disabled={actionLoading}
                className="px-4 py-2 text-white bg-amber-500 rounded hover:bg-amber-600 disabled:opacity-50"
              >
                {actionLoading ? 'Rejecting…' : 'Reject'}
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
                    fileType={newImage ? undefined : receipt.fileType}
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
            <ReceiptSummary data={receipt} showImage={false} />

            {receipt.imageUrl && (
              <div className="mt-4">
                <h4 className="font-semibold text-gray-700 mb-2">Receipt Image</h4>
                <ImageViewer
                  imageUrl={receipt.imageUrl}
                  altText="Receipt"
                  containerClass="h-56 sm:h-80 md:h-96"
                  fileType={receipt.fileType}
                />
              </div>
            )}

            {receipt.id && (
              <div className="mt-6">
                <AuditTrail receiptId={receipt.id} ownerUid={userId} />
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
};

export default ReviewPanel;
