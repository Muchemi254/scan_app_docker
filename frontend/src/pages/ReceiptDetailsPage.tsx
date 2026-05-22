import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { useReceiptStore } from '../stores/receiptStore';
import ReceiptForm from '../components/ReceiptForm';
import AuditTrail from '../components/AuditTrail';

const ReceiptDetailsPage = ({ userId }: { userId: string | null }) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { upsert, remove } = useReceiptStore();
  const [receipt, setReceipt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newImage, setNewImage] = useState<File | null>(null);

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
    } catch (error) {
      console.error("Error updating receipt:", error);
      alert(error instanceof Error ? error.message : "Update failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this receipt?')) return;
    if (!id) return;

    try {
      setLoading(true);
      await receiptApi.delete(id);
      remove(id); // drop from cache
      navigate('/receipts');
    } catch (error) {
      console.error("Error deleting receipt:", error);
      alert(error instanceof Error ? error.message : "Delete failed");
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="flex items-center justify-center min-h-screen"><div>Loading...</div></div>;
  if (!receipt) return <div className="flex items-center justify-center min-h-screen"><div>Receipt not found</div></div>;

  return (
    <div className="w-full px-4 py-4 sm:py-6">
      <div className="bg-white p-4 sm:p-6 rounded-lg shadow">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 mb-4 sm:mb-6">
          <h2 className="text-lg sm:text-xl font-bold truncate">
            {receipt.supplier || 'Receipt Details'}
          </h2>
          <div className="flex gap-2">
            <button
              onClick={() => setEditing(!editing)}
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
          <ReceiptForm
            initialData={receipt}
            onSubmit={handleUpdate}
            onImageChange={setNewImage}
            loading={loading}
          />
        ) : (
          <div className="space-y-2">
            <p><strong>Supplier:</strong> {receipt.supplier}</p>
            <p><strong>Total:</strong> {receipt.totalAmount}</p>
            <p><strong>Tax:</strong> {receipt.taxAmount}</p>
            <p><strong>Date:</strong> {receipt.receiptDate}</p>
            <p><strong>Category:</strong> {receipt.category}</p>
            {receipt.imageUrl && (
              <div>
                <img src={receipt.imageUrl} alt="Receipt" className="max-w-md mt-4" />
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
