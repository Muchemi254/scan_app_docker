import { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { receiptApi, locationsApi, settingsApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import ReceiptForm from '../components/ReceiptForm';
import { lineTotalOf, sumItemTotals } from '../utils/itemTotals';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { toast } from '../stores/toastStore';
import AuditTrail from '../components/AuditTrail';
import ImageViewer from '../components/ImageViewer';

const ReceiptDetailsPage = ({ userId }: { userId: string | null }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = searchParams.get('returnTo');
  const { upsert, remove } = useReceiptStore();
  const { confirm, dialog: deleteDialog } = useConfirmDelete();
  const [receipt, setReceipt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newImage, setNewImage] = useState<File | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [defaultTaxRate, setDefaultTaxRate] = useState(16);

  useEffect(() => {
    if (!userId || !id) return;

    const fetchReceipt = async () => {
      try {
        const data = await receiptApi.get(id);
        setReceipt(data);
      } catch (error) {
        console.error('Failed to fetch receipt:', error);
        navigate('/');
      } finally {
        setLoading(false);
      }
    };

    fetchReceipt();

    // Reference data + the user's personal tax default for the editor.
    const fetchMeta = async () => {
      try { setLocations((await locationsApi.list()).items); } catch { /* non-fatal */ }
      try { setDefaultTaxRate((await settingsApi.getTaxPreference()).default_tax_rate); } catch { /* non-fatal */ }
    };
    fetchMeta();
  }, [userId, id, navigate]);

  const handleUpdate = async (updatedData: any) => {
    if (!id) return;

    try {
      setLoading(true);
      const updated = await receiptApi.update(id, updatedData, newImage || undefined);
      upsert(updated); // sync cache
      setReceipt(updated);
      setEditing(false);
      setNewImage(null);
      if (returnTo) {
        navigate(returnTo);
        return;
      }
    } catch (error) {
      console.error("Error updating receipt:", error);
      alert(error instanceof Error ? error.message : "Update failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    if (!(await confirm({
      title: 'Delete receipt?',
      message: (
        <>
          Delete <strong>{receipt?.supplier || 'this receipt'}</strong>? This cannot be undone.
        </>
      ),
    }))) return;

    try {
      setLoading(true);
      await receiptApi.delete(id);
      remove(id); // drop from cache
      toast.success('Receipt deleted', receipt?.supplier || 'The receipt was removed.');
      navigate('/receipts');
    } catch (error) {
      console.error("Error deleting receipt:", error);
      toast.error('Delete failed', error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div>Loading...</div></div>;
  if (!receipt) return <div className="flex items-center justify-center min-h-screen"><div>Receipt not found</div></div>;

  const imageUrl = newImage ? URL.createObjectURL(newImage) : receipt.imageUrl;

  return (
    <div className="w-full px-4 py-4 sm:py-6">
      {deleteDialog}
      <div className="bg-white p-4 sm:p-6 rounded-lg shadow">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4 sm:mb-6">
          <div className="flex items-center gap-3 min-w-0">
            {returnTo && (
              <button
                onClick={() => navigate(returnTo)}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                title="Back to cleaning"
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
            )}
            <h2 className="text-lg sm:text-xl font-bold truncate">
              {receipt.supplier || 'Receipt Details'}
            </h2>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                if (editing && returnTo) { navigate(returnTo); return; }
                setEditing(!editing);
              }}
              className="flex-1 sm:flex-none px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
              disabled={loading}
            >
              {editing ? 'Cancel' : 'Edit'}
            </button>
            <button
              onClick={handleDelete}
              className="flex-1 sm:flex-none px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
              disabled={loading}
            >
              Delete
            </button>
          </div>
        </div>

        {editing ? (
          /* Edit mode: form + image side-by-side on lg (same pattern as ReviewPanel) */
          <div className="flex flex-col lg:flex-row lg:gap-4">
            {imageUrl && (
              <div className="sticky top-0 z-10 lg:static lg:w-1/2 xl:w-[55%] flex-shrink-0 bg-gray-50 rounded border border-gray-200 order-first lg:order-last flex flex-col">
                <div className="flex-shrink-0 px-3 pt-2 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-2">
                  Receipt Image
                  {receipt?.fileType === 'application/pdf' && (
                    <span className="rounded bg-red-100 text-red-700 px-1.5 py-0.5 text-[10px] font-semibold">
                      PDF{receipt.pdfPageCount ? ` · ${receipt.pdfPageCount}p` : ''}
                    </span>
                  )}
                </div>
                <div className="p-2 lg:flex-1">
                  <ImageViewer
                    imageUrl={imageUrl}
                    altText="Receipt"
                    containerClass="h-48 sm:h-64 lg:h-full lg:min-h-[60vh]"
                    fileType={newImage ? undefined : receipt?.fileType}
                  />
                </div>
              </div>
            )}
            <div className={`flex-1 min-w-0 ${!imageUrl ? 'w-full' : ''}`}>
              <ReceiptForm
                initialData={receipt}
                onSubmit={handleUpdate}
                onImageChange={setNewImage}
                loading={loading}
                locations={locations}
                defaultTaxRate={defaultTaxRate}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p><strong>Supplier:</strong> {receipt.supplier}</p>
            <p><strong>Total:</strong> {receipt.totalAmount}</p>
            <p><strong>Tax:</strong> {receipt.taxAmount}</p>
            <p><strong>Date:</strong> {receipt.receiptDate}</p>
            <p><strong>Category:</strong> {receipt.category}</p>
            {receipt.location && <p><strong>Location:</strong> {receipt.location}</p>}
            {receipt.taxRate != null && receipt.taxRate !== '' && <p><strong>Tax Rate:</strong> {receipt.taxRate}%</p>}
            {receipt.kraPin && <p><strong>Seller KRA PIN:</strong> {receipt.kraPin}</p>}
            {receipt.buyerKraPin && <p><strong>Buyer KRA PIN:</strong> {receipt.buyerKraPin}</p>}
            {receipt.cuInvoice && <p><strong>CU Invoice:</strong> {receipt.cuInvoice}</p>}
            {receipt.imageUrl && (
              <div className="mt-4">
                <h3 className="font-semibold text-gray-700 mb-2">Receipt Image</h3>
                <ImageViewer
                  imageUrl={receipt.imageUrl}
                  altText="Receipt"
                  containerClass="h-56 sm:h-80 md:h-96"
                />
              </div>
            )}

            {/* Items table */}
            {receipt.items && receipt.items.length > 0 && (
              <div className="mt-4">
                <h3 className="font-semibold text-gray-700 mb-2">Items</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-3 py-2 text-left">#</th>
                        <th className="px-3 py-2 text-left">Name</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-right">Price</th>
                        <th className="px-3 py-2 text-right">Tax</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {receipt.items.map((item: any, idx: number) => {
                        const lineTotal = lineTotalOf(item);
                        return (
                          <tr key={idx}>
                            <td className="px-3 py-2">{idx + 1}</td>
                            <td className="px-3 py-2">{item.name}</td>
                            <td className="px-3 py-2 text-right">{item.quantity}</td>
                            <td className="px-3 py-2 text-right">{item.price}</td>
                            <td className="px-3 py-2 text-right">{item.tax || '-'}</td>
                            <td className="px-3 py-2 text-right font-medium">{lineTotal.toFixed(2)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {(() => {
                      const totals = sumItemTotals(receipt.items);
                      return (
                        <tfoot className="bg-gray-50 border-t-2 border-gray-300">
                          <tr className="text-xs font-semibold text-gray-700">
                            <td colSpan={4} className="px-3 py-2 text-right">Totals</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.tax.toFixed(2)}</td>
                            <td className="px-3 py-2 text-right font-mono tabular-nums">{totals.total.toFixed(2)}</td>
                          </tr>
                        </tfoot>
                      );
                    })()}
                  </table>
                </div>
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

export default ReceiptDetailsPage;
