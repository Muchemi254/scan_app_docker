/**
 * useConfirmDelete — promise-based delete confirmation.
 *
 * Returns { confirm, dialog } where `confirm(opts)` resolves true only if the
 * user hit "Delete" in the shared ConfirmDeleteDialog, and `dialog` is the
 * element to mount once (typically at the root of the page).
 */
import { useCallback, useRef, useState } from 'react';
import { ConfirmDeleteDialog } from '../components/ConfirmDeleteDialog';

export interface ConfirmDeleteOpts {
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
}

export const useConfirmDelete = () => {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmDeleteOpts>({ title: '' });
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmDeleteOpts): Promise<boolean> => {
    setOpts(o);
    setOpen(true);
    return new Promise<boolean>(resolve => {
      resolver.current = resolve;
    });
  }, []);

  const finish = useCallback((v: boolean) => {
    setOpen(false);
    resolver.current?.(v);
    resolver.current = null;
  }, []);

  const dialog = (
    <ConfirmDeleteDialog
      open={open}
      title={opts.title}
      message={opts.message}
      confirmLabel={opts.confirmLabel}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  );

  return { confirm, dialog };
};
