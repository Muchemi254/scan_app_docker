/**
 * Global toast notification store.
 *
 * Replaces scattered alert() calls and inline error banners with a single,
 * dismissible toast queue. Toasts auto-dismiss after `duration` ms
 * (default 5000); pass duration: 0 to keep them until dismissed.
 */

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (type: ToastType, title: string, message?: string, opts?: { duration?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;
const DEFAULT_DURATION = 5000;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (type, title, message, opts = {}) => {
    const duration = opts.duration ?? DEFAULT_DURATION;
    const id = nextId++;
    set(s => ({ toasts: [...s.toasts, { id, type, title, message, duration }] }));
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },
  dismiss: id => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** Imperative helpers for use outside React components / hooks. */
export const toast = {
  success: (title: string, message?: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('success', title, message, opts),
  error: (title: string, message?: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('error', title, message, opts),
  info: (title: string, message?: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('info', title, message, opts),
  warning: (title: string, message?: string, opts?: { duration?: number }) =>
    useToastStore.getState().push('warning', title, message, opts),
};