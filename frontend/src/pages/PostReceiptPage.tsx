import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { receiptApi } from '../services/api';
import { getLocations, getEntryTypes } from '../services/referenceData';
import { useReceiptStore } from '../stores/receiptStore';
import ReceiptForm from '../components/ReceiptForm';
import type { ViewerImage } from '../components/ImageViewer';

const PostReceiptPage = ({ userId }: { userId: string | null }) => {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const [stagedImages, setStagedImages] = useState<ViewerImage[]>([]);
  const { add } = useReceiptStore();
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [entryTypes, setEntryTypes] = useState<{ id: string; name: string; label: string }[]>([]);
  useEffect(() => {
    getLocations().then(r => setLocations(r.items)).catch(() => {});
    getEntryTypes().then(r => setEntryTypes(r.items)).catch(() => {});
  }, []);

  const handleSubmit = async (data: any) => {
    if (!userId) return;
    await saveReceipt(data);
  };

  const saveReceipt = async (data: any) => {
    if (!userId) return;
    setLoading(true);
    try {
      const created = await receiptApi.create({ ...data, status: 'needs_review' });
      add(created);
      navigate('/receipts');
    } catch (error) {
      console.error('Failed to post receipt:', error);
      alert(error instanceof Error ? error.message : "Failed to create receipt");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 w-full">
      <h1 className="text-xl font-semibold mb-4 text-blue-600">!!!USE THIS WHEN SCANNING FAILS</h1>
      <h2 className="text-xl font-semibold mb-4">📝 Manually Post Receipt</h2>

      <ReceiptForm
        initialData={{}}
        onSubmit={handleSubmit}
        stagedImages={stagedImages}
        onImagesChange={(staged) => setStagedImages(staged)}
        loading={loading}
        locations={locations}
        entryTypes={entryTypes}
      />
    </div>
  );
};

export default PostReceiptPage;
