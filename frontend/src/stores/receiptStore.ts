/**
 * Global receipt cache store (in-memory only).
 *
 * Caches receipts for the lifetime of the browser tab so navigating
 * between pages doesn't trigger repeated API calls.  Intentionally
 * NOT persisted to localStorage — that caused cross-device staleness
 * where one device would serve a stale (or empty) cache while another
 * had fresh data.
 *
 * Freshness rules:
 *  - Cache is valid for CACHE_TTL_MS (5 minutes) within a session
 *  - Cache is per-user — switching users forces a re-fetch
 *  - Mutations (create/update/delete) do optimistic local updates,
 *    so no re-fetch is needed after them
 *  - `invalidate()` marks the cache stale (next load() will re-fetch)
 */

import { create } from 'zustand';
import { receiptApi } from '../services/api';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface ReceiptStoreState {
  items: any[];
  fetchedAt: number | null;
  cachedUserId: string | null;
  loading: boolean;
  error: string | null;
}

interface ReceiptStoreActions {
  /** True if the cache is populated, fresh, and belongs to this user. */
  isFresh: (userId: string) => boolean;

  /**
   * Ensure receipts are loaded for this user.
   * Returns immediately if cache is fresh; otherwise fetches from API.
   * Pass force=true to always re-fetch.
   */
  load: (userId: string, force?: boolean) => Promise<void>;

  /** Mark the cache as stale. The next load() will re-fetch. */
  invalidate: () => void;

  /** Drop the cache entirely (used on logout so data never outlives a session). */
  reset: () => void;

  /** Add a new receipt to the top of the cache (after create). */
  add: (receipt: any) => void;

  /** Update an existing receipt in-place (after update). */
  upsert: (receipt: any) => void;

  /** Remove a receipt from the cache (after delete). */
  remove: (id: string) => void;
}

type ReceiptStore = ReceiptStoreState & ReceiptStoreActions;

export const useReceiptStore = create<ReceiptStore>()((set, get) => ({
  items: [],
  fetchedAt: null,
  cachedUserId: null,
  loading: false,
  error: null,

  isFresh: (userId: string) => {
    const { fetchedAt, cachedUserId } = get();
    if (!fetchedAt || cachedUserId !== userId) return false;
    return Date.now() - fetchedAt < CACHE_TTL_MS;
  },

  load: async (userId: string, force = false) => {
    const { isFresh, loading } = get();

    // Don't double-fetch
    if (loading) return;

    // Serve from cache if still fresh
    if (!force && isFresh(userId)) return;

    set({ loading: true, error: null });
    try {
      const response = await receiptApi.list(0, 1000);
      set({
        items: response.items || [],
        fetchedAt: Date.now(),
        cachedUserId: userId,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err.message ?? 'Failed to load receipts' });
    }
  },

  invalidate: () => set({ fetchedAt: null }),

  reset: () => set({ items: [], fetchedAt: null, cachedUserId: null, loading: false, error: null }),

  add: (receipt: any) =>
    set(state => ({ items: [receipt, ...state.items] })),

  upsert: (receipt: any) =>
    set(state => {
      const idx = state.items.findIndex(r => r.id === receipt.id);
      if (idx < 0) return { items: [receipt, ...state.items] };
      const next = [...state.items];
      next[idx] = { ...next[idx], ...receipt };
      return { items: next };
    }),

  remove: (id: string) =>
    set(state => ({ items: state.items.filter(r => r.id !== id) })),
}));
