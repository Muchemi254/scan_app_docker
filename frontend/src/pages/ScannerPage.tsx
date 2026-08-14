/**
 * ScannerPage — upload + local prep only.
 *
 * Images are optimized, hashed, deduped, and stored on the server into
 * durable `prepared` holding state. NOTHING is sent to AI here — the user
 * decides what to dispatch (per group / per item / all) on the Scans page,
 * now or weeks later. Held work survives restarts and never needs re-upload.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { batchApi } from '../services/api';
import { toast } from '../stores/toastStore';

const MAX_UPLOAD_SIZE_MB = 500;
const CHUNK_SIZE_MB = 250;  // frontend auto-splits selections above this into separate sessions

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

const ScannerPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();

  // Upload phase state (only set while a new scan is being uploaded).
  type UploadPhase = {
    chunkIndex: number;
    totalChunks: number;
    percent: number;
    totalFiles: number;
  } | null;
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>(null);

  // New-scan form state
  const [batchTitle, setBatchTitle] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState('');

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);
  const isOverLimit = totalSize > MAX_UPLOAD_SIZE_MB * 1024 * 1024;
  const willChunk = totalSize > CHUNK_SIZE_MB * 1024 * 1024;
  const chunkCount = willChunk ? Math.ceil(totalSize / (CHUNK_SIZE_MB * 1024 * 1024)) : 1;

  // Client-side duplicate detection (filename+size+mtime).
  const [duplicates, setDuplicates] = useState<Map<string, File[]>>(new Map());
  function fingerprint(file: File): string {
    return `${file.size}_${file.lastModified}_${file.name}`;
  }
  function detectDuplicates(files: File[]): Map<string, File[]> {
    const groups = new Map<string, File[]>();
    for (const f of files) {
      const fp = fingerprint(f);
      if (!groups.has(fp)) groups.set(fp, []);
      groups.get(fp)!.push(f);
    }
    const dupes = new Map<string, File[]>();
    for (const [k, v] of groups) if (v.length > 1) dupes.set(k, v);
    return dupes;
  }
  const totalDupes = Array.from(duplicates.values()).reduce((acc, g) => acc + g.length - 1, 0);

  // ── Upload + prep ────────────────────────────────────────────────────────

  const handleProcess = async () => {
    if (!userId) return;
    if (!batchTitle.trim()) { setFormError('Enter a batch title.'); return; }
    if (selectedFiles.length === 0) { setFormError('Select at least one image.'); return; }
    setFormError('');

    // Build sub-batches by size (one if < 250MB, otherwise auto-split).
    const chunks: File[][] = [];
    let currentChunk: File[] = [];
    let currentSize = 0;
    for (const f of selectedFiles) {
      if (currentSize + f.size > CHUNK_SIZE_MB * 1024 * 1024 && currentChunk.length > 0) {
        chunks.push(currentChunk); currentChunk = []; currentSize = 0;
      }
      currentChunk.push(f); currentSize += f.size;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    try {
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const chunkTitle = chunks.length > 1 ? `${batchTitle.trim()} ${ci + 1}` : batchTitle.trim();

        setUploadPhase({ chunkIndex: ci, totalChunks: chunks.length, percent: 0, totalFiles: chunk.length });

        const { batchId } = await batchApi.create(chunkTitle, chunk.map(f => f.name));
        try {
          await batchApi.process(batchId, chunk, (percent) => {
            setUploadPhase(p => p ? { ...p, percent } : p);
          });
        } catch (uploadErr) {
          await batchApi.dismiss(batchId).catch(() => {});
          throw uploadErr;
        }
      }

      toast.success(
        'Images prepared',
        `${selectedFiles.length} image(s) locally processed and held. Manage & dispatch them in Scans.`
      );
      navigate('/scans');
    } catch (err: any) {
      setFormError(err.message ?? 'Upload failed — please try again.');
      toast.error('Upload failed', err?.message ?? 'Please try again.');
    } finally {
      setUploadPhase(null);
      setSelectedFiles([]);
      setBatchTitle('');
      setDuplicates(new Map());
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="w-full p-4 sm:p-8">
      <div className="space-y-4 w-full max-w-3xl mx-auto">
        <div className="bg-white rounded-lg shadow-md p-4 sm:p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-800">📄 Scan Receipts</h2>
            <button
              onClick={() => navigate('/scans')}
              className="text-xs text-indigo-700 hover:underline font-medium"
            >
              Manage held scans →
            </button>
          </div>

          {uploadPhase ? (
            <div className="py-4 space-y-3">
              <div className="flex items-center gap-3 justify-center text-blue-600 font-medium text-sm">
                <div className="animate-spin h-5 w-5 border-2 border-blue-600 border-t-transparent rounded-full" />
                {uploadPhase.totalChunks > 1
                  ? <>Preparing sub-batch {uploadPhase.chunkIndex + 1} of {uploadPhase.totalChunks} — {uploadPhase.totalFiles} files — {uploadPhase.percent}%</>
                  : <>Preparing {uploadPhase.totalFiles} files — {uploadPhase.percent}%</>}
              </div>
              <div className="w-full max-w-md mx-auto h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all duration-300 ease-out" style={{ width: `${uploadPhase.percent}%` }} />
              </div>
              <p className="text-center text-xs text-gray-400">
                Images are being optimized and stored locally. Nothing is sent to AI yet.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">🏷️ Batch Title</label>
                <input
                  type="text"
                  value={batchTitle}
                  onChange={e => { setBatchTitle(e.target.value); setFormError(''); }}
                  placeholder="e.g. June Market Run"
                  className="w-full px-4 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-indigo-300"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">📁 Select Images</label>
                <input
                  type="file"
                  multiple
                  accept="image/*"
                  onChange={e => {
                    if (e.target.files) {
                      const files = Array.from(e.target.files);
                      setSelectedFiles(files);
                      setDuplicates(detectDuplicates(files));
                      setFormError('');
                    }
                  }}
                  className="block w-full text-sm text-gray-700
                    file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0
                    file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700
                    hover:file:bg-indigo-100"
                />
                <div className="flex justify-between items-center mt-1">
                  <p className="text-xs text-gray-500">
                    {selectedFiles.length > 0
                      ? `${selectedFiles.length} file(s) selected (${formatFileSize(totalSize)})`
                      : `Max upload size: ${MAX_UPLOAD_SIZE_MB}MB`}
                  </p>
                  {selectedFiles.length > 0 && (
                    <p className={`text-xs font-medium ${isOverLimit ? 'text-red-600' : 'text-gray-400'}`}>
                      {formatFileSize(totalSize)} / {MAX_UPLOAD_SIZE_MB}MB
                    </p>
                  )}
                </div>
                {isOverLimit && !willChunk && (
                  <p className="text-xs text-red-600 mt-1 font-semibold">
                    ⚠️ Selection exceeds {MAX_UPLOAD_SIZE_MB}MB limit. Please remove some files.
                  </p>
                )}
                {totalDupes > 0 && (
                  <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-amber-700 font-medium">
                        ⚠️ {totalDupes} duplicate file{totalDupes > 1 ? 's' : ''} detected
                      </span>
                      <button
                        onClick={() => {
                          const keep = new Map<string, File>();
                          for (const f of selectedFiles) {
                            const fp = fingerprint(f);
                            if (!keep.has(fp)) keep.set(fp, f);
                          }
                          setSelectedFiles(Array.from(keep.values()));
                          setDuplicates(new Map());
                        }}
                        className="px-2 py-0.5 bg-amber-200 text-amber-800 rounded hover:bg-amber-300 font-medium"
                      >
                        Remove duplicates
                      </button>
                    </div>
                  </div>
                )}
                {willChunk && selectedFiles.length > 0 && (
                  <p className="text-xs text-blue-600 mt-1">
                    ℹ️ {selectedFiles.length} files ({formatFileSize(totalSize)}) — will be split into {chunkCount} sub-batches.
                    Each appears as its own session in Scans.
                  </p>
                )}
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <button
                onClick={handleProcess}
                disabled={!batchTitle.trim() || selectedFiles.length === 0 || (isOverLimit && !willChunk)}
                className="w-full py-2 px-4 rounded-md text-white font-medium text-lg transition
                  bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 disabled:cursor-not-allowed"
              >
                📤 Prepare Images
              </button>

              <p className="text-xs text-gray-400 text-center">
                Prep is free and instant. Sending to AI costs credits — you choose what to send and when, on the Scans page.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScannerPage;
