/**
 * ToastContainer — renders the global toast queue top-right, above all content.
 * Register exactly once (in App.tsx). Errors persist until dismissed or the
 * user navigates to the Notifications page for the durable log.
 */

import { useToastStore, type Toast, type ToastType } from '../stores/toastStore';
import { CircleCheck, CircleAlert, Info, CircleX, X } from 'lucide-react';

const STYLES: Record<ToastType, { box: string; icon: string; Icon: typeof CircleCheck }> = {
  success: { box: 'bg-white border-green-200', icon: 'text-green-600', Icon: CircleCheck },
  error:   { box: 'bg-white border-red-200',   icon: 'text-red-600',   Icon: CircleX },
  warning: { box: 'bg-white border-amber-200', icon: 'text-amber-600', Icon: CircleAlert },
  info:    { box: 'bg-white border-blue-200',  icon: 'text-blue-600',  Icon: Info },
};

const ToastCard = ({ toast }: { toast: Toast }) => {
  const dismiss = useToastStore(s => s.dismiss);
  const { box, icon, Icon } = STYLES[toast.type];

  return (
    <div
      role="status"
      className={`pointer-events-auto w-80 max-w-[90vw] rounded-lg shadow-lg border ${box} p-3 flex items-start gap-3 animate-[toastIn_.2s_ease-out]`}
    >
      <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${icon}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900 leading-snug">{toast.title}</p>
        {toast.message && (
          <p className="text-xs text-gray-600 mt-0.5 leading-snug break-words">{toast.message}</p>
        )}
      </div>
      <button
        onClick={() => dismiss(toast.id)}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition"
        aria-label="Dismiss notification"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
};

export const ToastContainer = () => {
  const toasts = useToastStore(s => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 sm:right-6 z-[90] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(t => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
};