/**
 * Local auth service (AUTH_MODE=local) — server-issued JWTs.
 *
 * Replaces the Firebase auth singleton. The access token + user are stored in
 * localStorage; every REST call attaches `Authorization: Bearer <token>`.
 * The backend rejects tokens for deleted users, so a 401 from /auth/me means
 * the session is dead.
 */

export interface AuthUser {
  uid: string;
  email: string;
  is_admin: boolean;
  display_name: string | null;
  created_at: string | null;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: AuthUser;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';
const TOKEN_KEY = 'scan-app-access-token';
const USER_KEY = 'scan-app-user';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

/**
 * Authorization header for protected endpoints. Sync — no async hydration
 * needed because the session is already in localStorage.
 */
export function getAuthHeader(): string {
  const token = getToken();
  if (!token) throw new Error('Authentication failed');
  return `Bearer ${token}`;
}

/**
 * Current user ID (sync — only call after auth is confirmed).
 */
export function getUserId(): string {
  const uid = getStoredUser()?.uid;
  if (!uid) throw new Error('User not authenticated');
  return uid;
}

function storeSession(resp: LoginResponse): void {
  localStorage.setItem(TOKEN_KEY, resp.access_token);
  localStorage.setItem(USER_KEY, JSON.stringify(resp.user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  // Also drop per-user state persisted by other stores (task progress,
  // in-progress scanner drafts) so a later login never inherits the
  // previous account's data.
  localStorage.removeItem('scan-app-task-store');
  localStorage.removeItem('scanner-context');
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const resp = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(json.detail || 'Invalid email or password');
  }
  storeSession(json as LoginResponse);
  return json.user as AuthUser;
}

/**
 * Hydrate the session from the server. Returns null (and clears storage) when
 * the token is missing, expired, or the user was deleted.
 */
export async function fetchMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const resp = await fetch(`${API_BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    clearSession();
    return null;
  }
  const user = (await resp.json()) as AuthUser;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export function logout(): void {
  clearSession();
}

// ── Admin: user management ─────────────────────────────────────────────────

export async function adminListUsers(): Promise<AuthUser[]> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/users`, {
    headers: { Authorization: getAuthHeader() },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to list users');
  return json;
}

export async function adminCreateUser(
  email: string,
  password: string,
  isAdmin = false,
  displayName?: string
): Promise<AuthUser> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({ email, password, is_admin: isAdmin, display_name: displayName || null }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to create user');
  return json;
}

export async function adminDeleteUser(uid: string, opId?: string): Promise<string> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/users/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: {
      Authorization: getAuthHeader(),
      ...(opId ? { 'X-Op-Id': opId } : {}),
    },
  });
  if (!resp.ok) {
    const json = await resp.json().catch(() => ({}));
    throw new Error(json.detail || 'Failed to delete user');
  }
  return resp.headers.get('X-Op-Id') || opId || '';
}

// ── Admin: trusted hosts (dynamic Host-header whitelist) ───────────────────

export async function adminGetTrustedHosts(): Promise<string[]> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/settings/trusted-hosts`, {
    headers: { Authorization: getAuthHeader() },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to load trusted hosts');
  return json.hosts || [];
}

export async function adminSetTrustedHosts(hosts: string[]): Promise<string[]> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/settings/trusted-hosts`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({ hosts }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to save trusted hosts');
  return json.hosts || [];
}

// ── Admin: shared AI provider keys (fallback for users without their own) ───

export interface AdminAIProvider {
  api_key?: string | null;
  enabled: boolean;
  model_id?: string | null;
  thinking_mode?: boolean;
}

export async function adminGetAIProviders(): Promise<Record<string, AdminAIProvider>> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/settings/ai-providers`, {
    headers: { Authorization: getAuthHeader() },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to load AI provider keys');
  return json.providers || {};
}

export async function adminSetAIProviders(
  providers: Record<string, AdminAIProvider>
): Promise<Record<string, AdminAIProvider>> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/settings/ai-providers`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({ providers }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to save AI provider keys');
  return json.providers || {};
}

export async function adminTestAIProvider(
  provider: string,
  modelId: string
): Promise<{ success: boolean; message: string }> {
  const resp = await fetch(`${API_BASE_URL}/auth/admin/settings/ai-providers/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(),
    },
    body: JSON.stringify({ provider, model_id: modelId }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.detail || 'Failed to test provider');
  return json;
}
