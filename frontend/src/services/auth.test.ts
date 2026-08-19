/**
 * Unit tests for the local auth service (services/auth.ts).
 *
 * Runs in node env — localStorage + fetch are stubbed globally.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  login,
  logout,
  getToken,
  getStoredUser,
  fetchMe,
  adminListUsers,
  adminCreateUser,
  adminDeleteUser,
  getAuthHeader,
  getUserId,
  type AuthUser,
} from './auth';

const TOKEN_KEY = 'scan-app-access-token';
const USER_KEY = 'scan-app-user';

const TEST_USER: AuthUser = {
  uid: 'uid-alice',
  email: 'alice@example.com',
  is_admin: false,
  display_name: null,
  created_at: '2026-01-01T00:00:00',
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, async json() { return body; } } as Response;
}

function mockLocalStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

beforeEach(() => {
  mockLocalStorage();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).localStorage;
});

describe('auth service', () => {
  it('login posts credentials and stores token + user', async () => {
    const token = 'jwt-token-123';
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: token,
        token_type: 'bearer',
        user: TEST_USER,
      })
    );

    const user = await login('alice@example.com', 'secret123');

    expect(user.uid).toBe(TEST_USER.uid);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'alice@example.com', password: 'secret123' }),
      })
    );
    expect(getToken()).toBe(token);
    expect(getStoredUser()?.email).toBe('alice@example.com');
    expect(getAuthHeader()).toBe(`Bearer ${token}`);
    expect(getUserId()).toBe(TEST_USER.uid);
  });

  it('login surfaces the backend 401 detail message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: 'Invalid email or password' }, false, 401)
    );

    await expect(login('nope@example.com', 'bad')).rejects.toThrow(
      'Invalid email or password'
    );
    expect(getToken()).toBeNull();
  });

  it('getAuthHeader / getUserId throw when not authenticated', () => {
    expect(() => getAuthHeader()).toThrow('Authentication failed');
    expect(() => getUserId()).toThrow('User not authenticated');
  });

  it('fetchMe returns the user for a valid session and refreshes it', async () => {
    localStorage.setItem(TOKEN_KEY, 'jwt-token-123');
    fetchMock.mockResolvedValue(jsonResponse(TEST_USER));

    const user = await fetchMe();

    expect(user?.uid).toBe(TEST_USER.uid);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/me',
      expect.objectContaining({
        headers: { Authorization: 'Bearer jwt-token-123' },
      })
    );
    expect(getStoredUser()?.uid).toBe(TEST_USER.uid);
  });

  it('fetchMe clears the session when the token is rejected (deleted user)', async () => {
    localStorage.setItem(TOKEN_KEY, 'stale-token');
    localStorage.setItem(USER_KEY, JSON.stringify(TEST_USER));
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'User no longer exists' }, false, 401));

    const user = await fetchMe();

    expect(user).toBeNull();
    expect(getToken()).toBeNull();
    expect(getStoredUser()).toBeNull();
  });

  it('logout clears the persisted session', async () => {
    localStorage.setItem(TOKEN_KEY, 'jwt-token-123');
    localStorage.setItem(USER_KEY, JSON.stringify(TEST_USER));

    logout();

    expect(getToken()).toBeNull();
    expect(getStoredUser()).toBeNull();
  });

  it('adminCreateUser sends an authenticated admin request', async () => {
    localStorage.setItem(TOKEN_KEY, 'admin-token');
    fetchMock.mockResolvedValue(
      jsonResponse({ ...TEST_USER, uid: 'uid-bob', email: 'bob@example.com' })
    );

    const created = await adminCreateUser('bob@example.com', 'pw12345678', true, 'Bob');

    expect(created.uid).toBe('uid-bob');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/admin/users',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('"email":"bob@example.com"'),
      })
    );
  });

  it('adminListUsers throws on non-admin (403)', async () => {
    localStorage.setItem(TOKEN_KEY, 'user-token');
    fetchMock.mockResolvedValue(jsonResponse({ detail: 'Admin privileges required' }, false, 403));

    await expect(adminListUsers()).rejects.toThrow('Admin privileges required');
  });

  it('adminDeleteUser encodes the uid and returns without error on 204', async () => {
    localStorage.setItem(TOKEN_KEY, 'admin-token');
    fetchMock.mockResolvedValue({ ok: true, status: 204, headers: new Headers(), json: async () => ({}) } as Response);

    await adminDeleteUser('uid/with-slash');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/admin/users/uid%2Fwith-slash',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});