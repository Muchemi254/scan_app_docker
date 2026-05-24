import { auth } from './firebase';

/**
 * Get authorization header with Firebase token.
 * Waits up to 5 s for Firebase to restore a persisted session before giving up.
 */
export async function getAuthHeader(): Promise<string> {
  // Fast path — token already available
  if (auth?.currentUser) {
    const token = await auth.currentUser.getIdToken();
    if (token) return `Bearer ${token}`;
  }

  // Slow path — wait for Firebase to restore the session (up to 5 s)
  const token = await new Promise<string | null>(resolve => {
    if (!auth) { resolve(null); return; }
    const unsubscribe = auth.onAuthStateChanged(user => {
      unsubscribe();
      if (user) {
        user.getIdToken().then(t => resolve(t)).catch(() => resolve(null));
      } else {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });

  if (!token) throw new Error('Authentication failed');
  return `Bearer ${token}`;
}

/**
 * Get current user ID (sync — only call after auth is confirmed).
 */
export function getUserId(): string {
  const userId = auth?.currentUser?.uid;
  if (!userId) throw new Error('User not authenticated');
  return userId;
}
