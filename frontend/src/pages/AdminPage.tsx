// src/pages/AdminPage.tsx
import { useEffect, useState, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import {
  adminCreateUser,
  adminDeleteUser,
  adminGetAIProviders,
  adminGetTrustedHosts,
  adminListUsers,
  adminSetAIProviders,
  adminSetTrustedHosts,
  adminTestAIProvider,
  type AdminAIProvider,
  type AuthUser,
} from '../services/auth';
import { settingsApi } from '../services/api';
import {
  ShieldAlert, Plus, Trash2, RefreshCw, User as UserIcon, Globe, X, Key,
  Eye, EyeOff, CheckCircle, Shield, AlertCircle,
} from 'lucide-react';

interface Props {
  userId: string | null;
}

interface AIModel {
  id: string;
  name: string;
  provider: string;
  description: string;
  supports_thinking: boolean;
  caveat?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter (Qwen3 VL)',
  qwen: 'Alibaba Qwen (DashScope)',
};

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

  // Trusted hosts
  const [hosts, setHosts] = useState<string[]>([]);
  const [hostInput, setHostInput] = useState('');
  const [savingHosts, setSavingHosts] = useState(false);

  // Shared AI provider keys
  const [aiProviders, setAiProviders] = useState<Record<string, AdminAIProvider>>({});
  const [models, setModels] = useState<AIModel[]>([]);
  const [aiSaving, setAiSaving] = useState(false);
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

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

  const loadHosts = useCallback(async () => {
    setError('');
    try {
      setHosts(await adminGetTrustedHosts());
    } catch (err: any) {
      setError(err?.message || 'Failed to load trusted hosts');
    }
  }, []);

  const loadAIProviders = useCallback(async () => {
    setError('');
    try {
      setAiProviders(await adminGetAIProviders());
    } catch (err: any) {
      setError(err?.message || 'Failed to load AI provider keys');
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      setModels(await settingsApi.getAvailableModels());
    } catch (err: any) {
      console.error('Failed to load models', err);
    }
  }, []);

  useEffect(() => {
    loadUsers();
    loadHosts();
    loadAIProviders();
    loadModels();
  }, [loadUsers, loadHosts, loadAIProviders, loadModels]);

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

  const addHost = () => {
    const h = hostInput.trim();
    if (!h) return;
    setHosts(prev => (prev.includes(h) ? prev : [...prev, h]));
    setHostInput('');
  };

  const saveHosts = async () => {
    setSavingHosts(true);
    setError('');
    setNotice('');
    try {
      setHosts(await adminSetTrustedHosts(hosts));
      setNotice('Trusted hosts saved');
    } catch (err: any) {
      setError(err?.message || 'Failed to save trusted hosts');
    } finally {
      setSavingHosts(false);
    }
  };

  const updateAIProvider = (provider: string, patch: Partial<AdminAIProvider>) => {
    setAiProviders(prev => ({
      ...prev,
      [provider]: { ...(prev[provider] || { enabled: true, api_key: '', model_id: '' }), ...patch },
    }));
  };

  const saveAIProviders = async () => {
    setAiSaving(true);
    setError('');
    setNotice('');
    try {
      setAiProviders(await adminSetAIProviders(aiProviders));
      setNotice('AI provider keys saved');
    } catch (err: any) {
      setError(err?.message || 'Failed to save AI provider keys');
    } finally {
      setAiSaving(false);
    }
  };

  const testAIProvider = async (provider: string) => {
    setTestingProvider(provider);
    setError('');
    setNotice('');
    try {
      const cfg = aiProviders[provider];
      const result = await adminTestAIProvider(provider, cfg.model_id || '');
      if (result.success) {
        setNotice(`${PROVIDER_LABELS[provider]} key is valid`);
      } else {
        setError(`${PROVIDER_LABELS[provider]}: ${result.message}`);
      }
    } catch (err: any) {
      setError(err?.message || `Failed to test ${PROVIDER_LABELS[provider]}`);
    } finally {
      setTestingProvider(null);
    }
  };

  const providerModels = (provider: string) => models.filter(m => m.provider === provider);
  const selectedModelSupportsThinking = (provider: string) => {
    const cfg = aiProviders[provider];
    const model = models.find(m => m.id === cfg?.model_id);
    return !!model?.supports_thinking;
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

        {/* Trusted hosts */}
        <div className="bg-white rounded-xl shadow p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <Globe className="h-5 w-5 text-blue-600" /> Trusted Hosts
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Allowed Host header values the backend accepts. Add the IP/hostname other devices
                use to reach this server (e.g. <code className="text-xs bg-gray-100 px-1 rounded">192.168.1.195</code>).
                Use <code className="text-xs bg-gray-100 px-1 rounded">*</code> to allow any host (roaming laptops).
                No restart needed — changes apply immediately.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {hosts.length === 0 && (
              <span className="text-sm text-gray-400">No hosts configured (all requests allowed).</span>
            )}
            {hosts.map(h => (
              <span
                key={h}
                className="inline-flex items-center gap-1.5 bg-gray-100 text-gray-700 text-sm rounded-full px-3 py-1"
              >
                {h}
                <button
                  onClick={() => setHosts(prev => prev.filter(x => x !== h))}
                  className="text-gray-400 hover:text-red-600"
                  aria-label={`Remove ${h}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={hostInput}
              onChange={e => setHostInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addHost();
                }
              }}
              className="flex-1 border border-gray-300 rounded-md p-2 text-sm"
              placeholder="e.g. 192.168.1.195"
            />
            <button
              onClick={addHost}
              className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 transition-colors"
            >
              <Plus className="h-4 w-4 inline -mt-0.5" /> Add
            </button>
            <button
              onClick={saveHosts}
              disabled={savingHosts}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {savingHosts ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>

        {/* Shared AI provider keys */}
        <div className="bg-white rounded-xl shadow p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
              <Key className="h-5 w-5 text-blue-600" /> Shared AI Provider Keys
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Fallback keys used for scanning when a user hasn't configured their own — one card per
              implemented provider. Users with their own key are unaffected. Disable a provider to
              stop using its shared key. Keys are stored encrypted; a{' '}
              <code className="text-xs bg-gray-100 px-1 rounded">********</code> value means the
              existing key is kept. Changes apply immediately.
            </p>
          </div>

          <div className="space-y-4">
            {Object.entries(aiProviders).map(([provider, cfg]) => {
              const isKeyConfigured = !!cfg.api_key?.startsWith('********');
              const supportsThinking = selectedModelSupportsThinking(provider);
              const modelOptions = providerModels(provider);
              return (
                <div
                  key={provider}
                  className="border border-gray-200 rounded-lg overflow-hidden"
                >
                  <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm font-semibold text-gray-800 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={cfg.enabled}
                        onChange={e => updateAIProvider(provider, { enabled: e.target.checked })}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600"
                      />
                      {PROVIDER_LABELS[provider] || provider}
                    </label>
                    {isKeyConfigured && cfg.enabled && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-100 text-green-700 text-xs font-bold rounded-full">
                        <CheckCircle className="h-3 w-3" /> ALREADY SETUP
                      </span>
                    )}
                  </div>

                  {cfg.enabled && (
                    <div className="p-4 space-y-3">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                        <select
                          value={cfg.model_id ?? ''}
                          onChange={e => updateAIProvider(provider, { model_id: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          {modelOptions.map(m => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                        </select>
                        {models.find(m => m.id === cfg.model_id)?.description && (
                          <p className="mt-1 text-xs text-gray-500">
                            {models.find(m => m.id === cfg.model_id)?.description}
                          </p>
                        )}
                        {models.find(m => m.id === cfg.model_id)?.caveat && (
                          <div className="mt-1 p-2 bg-amber-50 rounded-lg border border-amber-200 flex gap-2">
                            <AlertCircle className="h-3 w-3 text-amber-600 shrink-0 mt-0.5" />
                            <p className="text-xs text-amber-700 leading-relaxed">
                              {models.find(m => m.id === cfg.model_id)?.caveat}
                            </p>
                          </div>
                        )}
                      </div>

                      {supportsThinking && (
                        <div className="flex items-center gap-2 p-3 bg-purple-50 rounded-lg border border-purple-100">
                          <input
                            type="checkbox"
                            id={`thinking-${provider}`}
                            checked={!!cfg.thinking_mode}
                            onChange={e => updateAIProvider(provider, { thinking_mode: e.target.checked })}
                            className="h-4 w-4 text-purple-600 border-gray-300 rounded"
                          />
                          <label htmlFor={`thinking-${provider}`} className="text-sm font-medium text-purple-900">
                            Enable Thinking Mode
                          </label>
                        </div>
                      )}

                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                        <div className="relative">
                          <input
                            type={showKeys[provider] ? 'text' : 'password'}
                            value={cfg.api_key ?? ''}
                            onChange={e => updateAIProvider(provider, { api_key: e.target.value })}
                            placeholder={isKeyConfigured ? 'Key is saved and active' : 'Paste API key'}
                            className="w-full pl-10 pr-12 py-2 border border-gray-300 rounded-lg text-sm font-mono"
                          />
                          <Key className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                          <button
                            type="button"
                            onClick={() => setShowKeys(prev => ({ ...prev, [provider]: !prev[provider] }))}
                            className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600"
                            aria-label="Toggle key visibility"
                          >
                            {showKeys[provider] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          Used only when users don't set their own key. Stored encrypted; saved keys
                          are masked in this view.
                        </p>
                      </div>

                      <button
                        onClick={() => testAIProvider(provider)}
                        disabled={!cfg.api_key || testingProvider === provider}
                        className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 transition-colors"
                      >
                        {testingProvider === provider ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Shield className="h-4 w-4" />
                        )}
                        {testingProvider === provider ? 'Testing...' : 'Test Connection'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {Object.keys(aiProviders).length === 0 && (
              <p className="text-sm text-gray-400">No providers available.</p>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={saveAIProviders}
              disabled={aiSaving || testingProvider !== null}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {aiSaving ? 'Saving...' : 'Save AI Keys'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPage;