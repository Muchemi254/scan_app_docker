import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, AlertTriangle, ExternalLink, Trash2 } from 'lucide-react';
import { receiptApi } from '../services/api';
import type { ViewerImage } from './ImageViewer';

/**
 * Reusable image manager for a receipt (create + edit).
 *
 * A receipt holds 1..N images. This modal is the single place to view the
 * existing images, remove some, and add new files — used from the receipt
 * form so the form itself stays compact. It also runs the server-side
 * duplicate check on pick and surfaces "already used on <supplier>" with a
 * link, so a re-used image is caught before saving.
 *
 * Fully controlled: the parent owns `pending` (newly picked Files) and
 * `removedIds` (existing image ids to delete) and persists them on save.
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
  pending,
  removedIds,
  onChange,
  maxImages = 5,
  excludeReceiptId,
}: {
  open: boolean;
  onClose: () => void;
  existing: ViewerImage[];
  pending: File[];
  removedIds: string[];
  onChange: (next: { pending: File[]; removedIds: string[] }) => void;
  maxImages?: number;
  excludeReceiptId?: string;
}) => {
  const [conflicts, setConflicts] = useState<ImageConflict[]>([]);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const keptExisting = existing.filter((im) => im.id && !removedIds.includes(im.id));
  const total = keptExisting.length + pending.length;
  const atMax = total >= maxImages;

  // Object URLs for pending files (revoked on change/unmount).
  const pendingUrls = useMemo(
    () => pending.map((f) => URL.createObjectURL(f)),
    [pending],
  );
  useEffect(() => () => pendingUrls.forEach((u) => URL.revokeObjectURL(u)), [pendingUrls]);

  useEffect(() => {
    if (!open) setConflicts([]);
  }, [open]);

  const handlePick = async (files: File[]) => {
    if (!files.length) return;
    const room = Math.max(0, maxImages - keptExisting.length - pending.length);
    const accepted = files.slice(0, room);
    if (!accepted.length) return;

    setChecking(true);
    setConflicts([]);
    let blocked = new Set<number>();
    try {
      const res = await receiptApi.checkImages(accepted, excludeReceiptId);
      const found: ImageConflict[] = res.conflicts || [];
      setConflicts(found);
      blocked = new Set(found.map((c) => c.index));
    } catch {
      // Fail-open: if the check fails, let the save-time guard catch it.
    } finally {
      setChecking(false);
    }
    const allowed = accepted.filter((_, i) => !blocked.has(i));
    if (allowed.length) onChange({ pending: [...pending, ...allowed], removedIds });
  };

  const removePending = (idx: number) =>
    onChange({ pending: pending.filter((_, i) => i !== idx), removedIds });

  const removeExisting = (id: string, currentlyRemoved: boolean) => {
    const next = currentlyRemoved
      ? removedIds.filter((r) => r !== id)
      : [...removedIds, id];
    onChange({ pending, removedIds: next });
  };

  if (!open) return null;

  return (
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
          <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-500" title="Close">
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

          {/* Newly added (not yet saved) */}
          {pending.length > 0 && (
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">New — will be added on save</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {pending.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="relative rounded-lg border overflow-hidden bg-gray-50">
                    <img src={pendingUrls[i]} alt={f.name} className="w-full h-24 object-cover" />
                    <button
                      onClick={() => removePending(i)}
                      className="absolute top-1 right-1 w-6 h-6 flex items-center justify-center rounded-full bg-white/90 text-red-600 hover:bg-white shadow"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                    <p className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[9px] truncate px-1 py-0.5">{f.name}</p>
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

          {/* Add */}
          <div>
            <button
              onClick={() => inputRef.current?.click()}
              disabled={atMax || checking}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-600 hover:border-gray-400 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              {atMax ? `Maximum ${maxImages} images reached` : checking ? 'Checking…' : 'Add image(s)'}
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
              JPEG/PNG/WebP/HEIC or a single PDF. Each image is stored separately.
            </p>
          </div>
        </div>

        <div className="px-4 py-3 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImageManagerModal;
