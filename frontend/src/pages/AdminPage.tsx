// src/pages/AdminPage.tsx
import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  adminCreateUser,
  adminDeleteUser,
  adminListUsers,
  type AuthUser,
} from '../services/auth';
import { ShieldAlert, Plus, Trash2, RefreshCw, User as UserIcon } from 'lucide-react';

interface Props {
  userId: string | null;
}

const AdminPage = ({ userId }: Props) => {
  const currentUser = useAuthStore(s => s.user);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // Create form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    setError('');
    try {
      setUsers(await adminListUsers());
    } catch (err: any) {
      setError(err?.message || 'Failed to load users');
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // Admin-only guard
  if (!currentUser?.is_admin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4 py-8">
        <div className="text-center space-y-3 max-w-md bg-white p-8 rounded-xl shadow">
          <ShieldAlert className="h-10 w-10 text-red-500 mx-auto" />
          <h2 className="text-xl font-semibold text-gray-800">Access Denied</h2>
          <p className="text-sm text-gray-500">You need administrator privileges to view this page.</p>
        </div>
      </div>
    );
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    setNotice('');
    try {
      await adminCreateUser(email.trim(), password, isAdmin, displayName.trim() || undefined);
      setEmail('');
      setPassword('');
      setDisplayName('');
      setIsAdmin(false);
      setNotice(`Created ${email.trim()}`);
      await loadUsers();
    } catch (err: any) {
      setError(err?.message || 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user: AuthUser) => {
    if (user.uid === userId) {
      setError('You cannot delete your own account');
      return;
    }
    if (!window.confirm(`Delete ${user.email}? This removes their account and revokes their sessions.`)) return;
    setError('');
    setNotice('');
    try {
      await adminDeleteUser(user.uid);
      setNotice(`Deleted ${user.email}`);
      await loadUsers();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete user');
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6 sm:py-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Admin — User Management</h1>
            <p className="text-sm text-gray-500">Accounts are created by administrators only.</p>
          </div>
          <button
            onClick={loadUsers}
            disabled={loadingUsers}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-white border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${loadingUsers ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
        )}
        {notice && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">{notice}</div>
        )}

        {/* Create user */}
        <form onSubmit={handleCreate} className="bg-white rounded-xl shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <Plus className="h-5 w-5 text-blue-600" /> Create User
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-2 text-sm"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={e => setPassword(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-2 text-sm"
                placeholder="Min 8 characters"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Display Name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                className="w-full border border-gray-300 rounded-md p-2 text-sm"
                placeholder="Optional"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-600 pb-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isAdmin}
                  onChange={e => setIsAdmin(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600"
                />
                Administrator
              </label>
            </div>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="w-full sm:w-auto px-5 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Account'}
          </button>
        </form>

        {/* User list */}
        <div className="bg-white rounded-xl shadow overflow-hidden">
          <h2 className="text-lg font-semibold text-gray-800 px-6 pt-6 flex items-center gap-2">
            <UserIcon className="h-5 w-5 text-blue-600" /> Users ({users.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm mt-4">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="px-6 py-3 font-medium">Email</th>
                  <th className="px-6 py-3 font-medium">Role</th>
                  <th className="px-6 py-3 font-medium">Created</th>
                  <th className="px-6 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.uid} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-6 py-3">
                      <span className="font-medium text-gray-800">{u.email}</span>
                      {u.uid === userId && (
                        <span className="ml-2 text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5">you</span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      {u.is_admin ? (
                        <span className="text-xs bg-purple-100 text-purple-700 rounded-full px-2 py-0.5">admin</span>
                      ) : (
                        <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">user</span>
                      )}
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-6 py-3 text-right">
                      <button
                        onClick={() => handleDelete(u)}
                        disabled={u.uid === userId}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="h-4 w-4" /> Delete
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loadingUsers && (
                  <tr>
                    <td colSpan={4} className="px-6 py-8 text-center text-gray-400">No users found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPage;