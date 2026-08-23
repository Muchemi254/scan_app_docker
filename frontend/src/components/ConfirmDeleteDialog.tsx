/**
 * ConfirmDeleteDialog — reusable destructive-action confirmation modal.
 *
 * Combine with useConfirmDelete() to turn any delete action into a
 * promise-based confirm (no window.confirm), e.g.:
 *
 *   const { confirm, dialog } = useConfirmDelete();
 *   const handleDelete = async () => {
 *     if (!(await confirm({ title: 'Delete receipt?', message: '...' }))) return;
 *     await api.delete(id);
 *   };
 *   ... {dialog}
 */

import { AlertTriangle } from 'lucide-react';

interface ConfirmDeleteDialogProps {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDeleteDialog = ({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDeleteDialogProps) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 h-9 w-9 rounded-full bg-red-50 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-base font-bold text-gray-900 leading-snug">{title}</h3>
            {message && <div className="text-sm text-gray-600 mt-1 leading-snug">{message}</div>}
          </div>
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 text-sm rounded font-medium bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className="px-4 py-2 text-sm rounded font-medium bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {isLoading ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
