import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { reviewBatchApi, type ReviewBatch } from '../services/reviewBatchApi';
import { Upload, Trash2, Eye, FileText, CheckCircle, Clock, Flag, AlertCircle } from 'lucide-react';

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: typeof CheckCircle }> = {
  pending_review: { label: 'Pending', color: 'bg-amber-100 text-amber-700', icon: Clock },
  in_review: { label: 'In Review', color: 'bg-blue-100 text-blue-700', icon: Eye },
  reviewed: { label: 'Reviewed', color: 'bg-green-100 text-green-700', icon: CheckCircle },
  flagged: { label: 'Flagged', color: 'bg-red-100 text-red-700', icon: Flag },
};

const ReviewBatchListPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const [batches, setBatches] = useState<ReviewBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [batchName, setBatchName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const loadBatches = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError('');
      const list = await reviewBatchApi.list();
      setBatches(list);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load batches');
      console.error('Failed to load batches', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    loadBatches();
  }, [userId, loadBatches]);

  const handleUpload = async () => {
    if (!selectedFile || !batchName.trim()) return;
    try {
      setUploading(true);
      setError('');
      await reviewBatchApi.upload(batchName.trim(), selectedFile);
      setBatchName('');
      setSelectedFile(null);
      await loadBatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (batchId: string, name: string) => {
    if (!confirm(`Delete review batch "${name}"? This won't delete the receipts themselves.`)) return;
    try {
      await reviewBatchApi.delete(batchId);
      setBatches(prev => prev.filter(b => b.id !== batchId));
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleFileDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.csv')) {
      setSelectedFile(file);
      if (!batchName) setBatchName(file.name.replace(/\.csv$/i, ''));
    }
  }, [batchName]);

  if (!userId) return null;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Review Batches</h1>
        <p className="text-sm text-gray-500 mt-1">
          Upload CSV files of receipt IDs to create focused review batches.
        </p>
      </div>

      {/* Upload section */}
      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <h2 className="font-semibold text-gray-700 flex items-center gap-2">
          <Upload className="h-4 w-4" /> Upload New Batch
        </h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="Batch name (e.g. March KRA Review)"
            value={batchName}
            onChange={e => setBatchName(e.target.value)}
            className="flex-1 px-3 py-2 border rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
          <div className="flex gap-2">
            <label
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              className={`px-4 py-2 border-2 border-dashed rounded-lg text-sm cursor-pointer transition-colors flex items-center gap-2
                ${dragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
                ${selectedFile ? 'border-green-500 bg-green-50' : ''}`}
            >
              <FileText className="h-4 w-4" />
              {selectedFile ? selectedFile.name : 'Choose CSV...'}
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setSelectedFile(file);
                    if (!batchName) setBatchName(file.name.replace(/\.csv$/i, ''));
                  }
                }}
              />
            </label>
            <button
              onClick={handleUpload}
              disabled={!selectedFile || !batchName.trim() || uploading}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {uploading ? 'Uploading...' : 'Create Batch'}
            </button>
          </div>
        </div>
        {error && (
          <div className="flex items-center gap-2 text-red-600 text-sm bg-red-50 px-3 py-2 rounded">
            <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
          </div>
        )}
        <p className="text-xs text-gray-400">
          CSV must have a column named <code className="bg-gray-100 px-1 rounded">receipt_id</code> with one receipt ID per row.
        </p>
      </div>

      {/* Batch list */}
      {loading ? (
        <div className="text-center py-12 text-gray-400">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent" />
          <p className="mt-3">Loading batches...</p>
        </div>
      ) : loadError ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <AlertCircle className="h-10 w-10 text-red-300 mx-auto mb-3" />
          <p className="text-red-600 font-medium">Failed to load batches</p>
          <p className="text-gray-500 text-sm mt-1">{loadError}</p>
          <button onClick={loadBatches} className="mt-3 px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600">
            Retry
          </button>
        </div>
      ) : batches.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg shadow">
          <FileText className="h-12 w-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No review batches yet. Upload a CSV to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {batches.map(batch => {
            const total = batch.total_items || batch.receipt_count || 0;
            const reviewed = batch.status_counts?.reviewed || 0;
            const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

            return (
              <div
                key={batch.id}
                className="bg-white rounded-lg shadow hover:shadow-md transition-shadow p-5 cursor-pointer"
                onClick={() => navigate(`/review-batches/${batch.id}`)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900 truncate">{batch.name}</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {batch.csv_filename && `${batch.csv_filename} · `}
                      {new Date(batch.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(batch.id, batch.name); }}
                    className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
                    title="Delete batch"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* Progress bar */}
                <div className="mt-3">
                  <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                    <span>{reviewed} of {total} reviewed</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-green-500 rounded-full transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>

                {/* Status chips */}
                <div className="flex gap-2 mt-3 flex-wrap">
                  {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                    const count = batch.status_counts?.[key] || 0;
                    if (count === 0) return null;
                    const Icon = cfg.icon;
                    return (
                      <span key={key} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cfg.color}`}>
                        <Icon className="h-3 w-3" /> {count} {cfg.label}
                      </span>
                    );
                  })}
                </div>

                <div className="mt-3 flex items-center gap-1 text-blue-600 text-xs font-medium">
                  <Eye className="h-3.5 w-3.5" /> Open batch
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ReviewBatchListPage;
