/**
 * Zustand store for the local auth session.
 *
 * Holds the token + current user. The token is persisted in localStorage by
 * services/auth.ts; this store is the reactive source of truth for components.
 */
import { create } from 'zustand';
import type { AuthUser } from '../services/auth';
import * as authService from '../services/auth';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  user: AuthUser | null;
  status: AuthStatus;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  restore: () => Promise<void>;
  signOut: () => void;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: getStoredUserOrNull(),
  status: 'loading',

  signIn: async (email: string, password: string) => {
    const user = await authService.login(email, password);
    set({ user, status: 'authenticated' });
    return user;
  },

  restore: async () => {
    const user = await authService.fetchMe();
    set(user ? { user, status: 'authenticated' } : { user: null, status: 'unauthenticated' });
  },

  signOut: () => {
    authService.logout();
    set({ user: null, status: 'unauthenticated' });
  },
}));

function getStoredUserOrNull(): AuthUser | null {
  // Importing authService at module scope above makes this circular-safe here.
  return authService.getStoredUser();
}
