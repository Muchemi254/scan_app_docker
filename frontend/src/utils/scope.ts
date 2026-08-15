/**
 * Admin scope-mode helpers.
 *
 * When an admin selects another user's scope (impersonation), the UI switches
 * to approval-mode: only receipts review + the approval queue are available.
 * Everything personal (Scanner, Settings, Notifications, Cleaning, Export...)
 * is hidden and locked so we never try to load/operate another user's data.
 */

import { useScopeStore } from '../stores/scopeStore';
import { useAuthStore } from '../stores/authStore';

/** True when an admin is operating inside another user's workspace. */
export function useIsImpersonating(): boolean {
  const activeUid = useScopeStore((s) => s.activeUid);
  const selfUid = useAuthStore((s) => s.user?.uid);
  return !!activeUid && activeUid !== selfUid;
}

/**
 * Paths available to an admin while impersonating another user.
 * Everything else is locked (Scanner, Settings, Cleaning, Export, …).
 */
export const IMPERSONATION_ALLOWED_PATHS = [
  '/receipts',
  '/review',
  '/approvals',
];

export function isAllowedWhileImpersonating(path: string): boolean {
  if (path === '/receipts' || path.startsWith('/receipts/')) return true;
  return IMPERSONATION_ALLOWED_PATHS.includes(path);
}
