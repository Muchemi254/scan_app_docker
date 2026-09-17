import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, AlertTriangle, ExternalLink, Trash2, Loader2 } from 'lucide-react';
import { receiptApi } from '../services/api';
import type { ViewerImage } from './ImageViewer';

/**
 * Reusable image manager for a receipt (create + edit).
 *
 * A receipt holds 1..N images. This modal is the single place to view the
 * existing images, remove some, and add new files — used from the receipt
 * form so the form itself stays compact.
 *
 * Adding goes through the SERVER pipeline first: on pick the files are
 * POSTed to /receipts/images/stage, which validates and processes them
 * (HEIC→JPEG, resize, thumbnail) and returns processed preview URLs while a
 * spinner is shown. The user never sees the raw local file. The same
 * request reports images already used on another receipt (with a link).
 *
 * Controlled: the parent owns `staged` (server-processed, unattached) and
 * `removedIds` and persists them on save.
 */
export interface ImageConflict {
  index: number;
  receiptId: string;
  supplier?: string | null;
}

const ImageManagerModal = ({
  open,
  onClose,
  existing,
  staged,
  removedIds,
  onChange,
  maxImages = 5,
  excludeReceiptId,
}: {
  open: boolean;
  onClose: () => void;
  existing: ViewerImage[];
  staged: ViewerImage[];
  removedIds: string[];
  onChange: (next: { staged: ViewerImage[]; removedIds: string[] }) => void;
  maxImages?: number;
  excludeReceiptId?: string;
}) => {
  const [conflicts, setConflicts] = useState<ImageConflict[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const keptExisting = existing.filter((im) => !(im.id && removedIds.includes(im.id)));
  const total = keptExisting.length + staged.length;
  const atMax = total >= maxImages;

  useEffect(() => {
    if (!open) { setConflicts([]); setError(null); }
  }, [open]);

  const handlePick = async (files: File[]) => {
    if (!files.length) return;
    const room = Math.max(0, maxImages - keptExisting.length - staged.length);
    const accepted = files.slice(0, room);
    if (!accepted.length) {
      setError(`Maximum ${maxImages} images reached`);
      return;
    }
    setConflicts([]);
    setError(null);
    setProcessing(accepted.length);
    try {
      const res = await receiptApi.stageImages(accepted, excludeReceiptId);
      setConflicts(res.conflicts || []);
      if (res.staged?.length) {
        onChange({ staged: [...staged, ...res.staged], removedIds });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to process image(s)');
    } finally {
      setProcessing(0);
    }
  };

  const discardStaged = async (id?: string | null, idx?: number) => {
    if (id) receiptApi.discardStagedImage(id).catch(() => {});
    onChange({ staged: staged.filter((_, i) => i !== idx), removedIds });
  };

  const removeExisting = (id: string, currentlyRemoved: boolean) => {
    const next = currentlyRemoved
      ? removedIds.filter((r) => r !== id)
      : [...removedIds, id];
    onChange({ staged, removedIds: next });
  };

  if (!open) return null;

  // Portal to <body> so the modal lives outside the ReceiptForm <form>.
  return createPortal(
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Receipt images</h3>
            <p className="text-xs text-gray-500">
              {total} of {maxImages} image{maxImages !== 1 ? 's' : ''} — a long receipt can be several photos
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4">
          {/* Existing images */}
          {existing.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Saved on this receipt</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {existing.map((im) => {
                  const removed = !!im.id && removedIds.includes(im.id);
                  return (
                    <div
                      key={im.id || im.imageUrl}
                      className={`relative rounded-lg border overflow-hidden bg-gray-50 ${removed ? 'opacity-40' : ''}`}
                    >
                      <img
                        src={`/api/images/cached?url=${encodeURIComponent(im.thumbnailUrl || im.imageUrl)}&thumb=1`}
                        alt=""
                        className="w-full h-24 object-cover"
                      />
                      {im.fileType === 'application/pdf' && (
                        <span className="absolute top-1 left-1 rounded bg-red-500 text-white text-[9px] font-semibold px-1 py-0.5">PDF</span>
                      )}
                      <button
                        type="button"
                        onClick={() => im.id && removeExisting(im.id, removed)}
                        className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-white/90 text-red-600 hover:bg-white shadow"
                        title={removed ? 'Undo remove' : 'Remove image'}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Newly staged (processed server-side, not yet saved) */}
          {staged.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">New — added on save</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {staged.map((im, i) => (
                  <div key={im.id || i} className="relative rounded-lg border overflow-hidden bg-gray-50">
                    <img
                      src={`/api/images/cached?url=${encodeURIComponent(im.thumbnailUrl || im.imageUrl)}&thumb=1`}
                      alt=""
                      className="w-full h-24 object-cover"
                    />
                    {im.fileType === 'application/pdf' && (
                      <span className="absolute top-1 left-1 rounded bg-red-500 text-white text-[9px] font-semibold px-1 py-0.5">PDF</span>
                    )}
                    <button
                      type="button"
                      onClick={() => discardStaged(im.id, i)}
                      className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-white/90 text-red-600 hover:bg-white shadow"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Processing placeholders — one per file being processed */}
          {processing > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Processing…</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {Array.from({ length: processing }).map((_, i) => (
                  <div key={i} className="rounded-lg border bg-gray-50 h-24 flex flex-col items-center justify-center gap-1.5">
                    <Loader2 className="h-5 w-5 text-blue-500 animate-spin" />
                    <span className="text-[10px] text-gray-400">Processing</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Duplicate warnings */}
          {conflicts.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
              <div className="flex items-center gap-2 text-amber-700 text-xs font-semibold">
                <AlertTriangle className="h-4 w-4" />
                {conflicts.length} image{conflicts.length > 1 ? 's' : ''} already used on another receipt
              </div>
              {conflicts.map((c) => (
                <div key={c.receiptId + c.index} className="flex items-center justify-between gap-2 text-xs text-amber-800">
                  <span className="truncate">
                    Already on <strong>{c.supplier || 'another receipt'}</strong>
                  </span>
                  <a
                    href={`/receipts?receipt=${encodeURIComponent(c.receiptId)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-amber-300 bg-white hover:bg-amber-100 text-amber-800 flex-shrink-0"
                  >
                    View <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
          )}

          {/* Add */}
          <div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={atMax || processing > 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {processing > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {atMax ? `Maximum ${maxImages} images reached` : processing > 0 ? 'Processing…' : 'Add image(s)'}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*,.pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                handlePick(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
            <p className="mt-1.5 text-[11px] text-gray-400">
              JPEG/PNG/WebP/HEIC or a single PDF. Each image is processed then stored separately.
            </p>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default ImageManagerModal;
