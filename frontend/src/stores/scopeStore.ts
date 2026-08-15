/**
 * Admin scope selector.
 *
 * Holds the currently active user scope (uid). For a normal user this is
 * always null → every API call targets their own uid. An admin can set it to
 * another user's uid to impersonate that user's workspace: every page loads
 * and edits that user's receipts (RLS adopts the target tenant on the backend).
 *
 * The api client reads `useScopeStore.getState().activeUid` synchronously to
 * build URLs (see services/api.ts getScopeUid).
 */
import { create } from 'zustand';

interface ScopeState {
  activeUid: string | null;
  setActiveUid: (uid: string | null) => void;
}

export const useScopeStore = create<ScopeState>()((set) => ({
  activeUid: null,
  setActiveUid: (uid) => set({ activeUid: uid }),
}));
