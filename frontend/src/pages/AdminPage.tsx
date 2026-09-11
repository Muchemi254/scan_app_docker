// src/pages/AdminPage.tsx
import { useEffect, useState, useCallback, useRef } from 'react';
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
  adminUpdateUser,
  type AdminAIProvider,
  type AuthUser,
} from '../services/auth';
import { opsApi } from '../services/opsApi';
import { settingsApi, locationsApi, entryTypesApi, industriesApi, categoriesApi } from '../services/api';
import { invalidateReferenceData } from '../services/referenceData';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import { toast } from '../stores/toastStore';
import {
  ShieldAlert, Plus, Trash2, RefreshCw, User as UserIcon, Globe, X, Key,
  Eye, EyeOff, CheckCircle, Shield, AlertCircle, MapPin, Database, Upload,
  Pencil, Save,
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

// Ops created more than this long ago that still claim "running" are stale
// (the server-side watchdog finalizes them) — never resume polling those.
const OP_RESUME_WINDOW_MS = 10 * 60 * 1000;

const isRecentOp = (o: { created_at?: string }) => {
  if (!o.created_at) return false;
  const age = Date.now() - new Date(o.created_at).getTime();
  return Number.isFinite(age) && age >= 0 && age <= OP_RESUME_WINDOW_MS;
};

const AdminPage = ({ userId }: Props) => {
  const currentUser = useAuthStore(s => s.user);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { confirm, dialog: deleteDialog } = useConfirmDelete();

  // Create form
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [creating, setCreating] = useState(false);

  // Edit user modal
  const [editingUser, setEditingUser] = useState<AuthUser | null>(null);
  const [editEmail, setEditEmail] = useState('');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editIsAdmin, setEditIsAdmin] = useState(false);
  const [editPassword, setEditPassword] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

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

  // Locations reference data
  const [locations, setLocations] = useState<{ id: string; name: string; is_active: boolean }[]>([]);
  const [locationInput, setLocationInput] = useState('');
  const [savingLocations, setSavingLocations] = useState(false);
  // Entry types reference data
  const [entryTypes, setEntryTypes] = useState<{ id: string; name: string; label: string; is_active: boolean; is_system: boolean }[]>([]);
  const [entryTypeName, setEntryTypeName] = useState('');
  const [entryTypeLabel, setEntryTypeLabel] = useState('');
  const [savingEntryTypes, setSavingEntryTypes] = useState(false);
  // Industries & Categories
  const [industries, setIndustries] = useState<{ id: string; name: string; description?: string; is_active: boolean; is_system: boolean }[]>([]);
  const [industryInput, setIndustryInput] = useState('');
  const [industryDesc, setIndustryDesc] = useState('');
  const [savingIndustries, setSavingIndustries] = useState(false);
  const [selectedIndustryId, setSelectedIndustryId] = useState<string | null>(null);
  const [categories, setCategories] = useState<{ id: string; industry_id: string; name: string; label: string; parent_id?: string | null; is_active: boolean; is_system: boolean }[]>([]);
  const [categoryName, setCategoryName] = useState('');
  const [categoryLabel, setCategoryLabel] = useState('');
  const [categoryParent, setCategoryParent] = useState<string>('');
  const [savingCategories, setSavingCategories] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  const [csvUploading, setCsvUploading] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

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

  // User deletions (background data purge — poll /ops for live progress).
  // Declared AFTER loadUsers since the pollers close over it.
  const [deleting, setDeleting] = useState<Record<string, { opId: string; email: string; status: string; message: string; counts: Record<string, number> }>>({});
  const deletePollers = useRef<Record<string, number>>({});

  const stopDeletePoll = useCallback((uid: string) => {
    const id = deletePollers.current[uid];
    if (id !== undefined) {
      clearInterval(id);
      delete deletePollers.current[uid];
    }
  }, []);

  const pollDeleteOp = useCallback((uid: string, opId: string, email: string) => {
    const tick = async () => {
      try {
        const op = await opsApi.getOp(opId);
        setDeleting(prev => ({ ...prev, [uid]: { opId, email, status: op.status, message: op.message, counts: op.counts } }));
        if (op.status === 'completed' || op.status === 'failed') {
          stopDeletePoll(uid);
          if (op.status === 'completed') {
            const c = op.counts;
            setNotice(`Deleted ${email} — ${c.rows ?? 0} rows, ${c.images ?? 0} image files removed`);
            toast.success('Account deleted', `Purging of ${email} finished — ${c.rows ?? 0} rows, ${c.images ?? 0} image files removed.`);
          } else {
            setError(op.message || `Deletion of ${email} failed`);
            toast.error('Delete failed', op.message || `Deletion of ${email} failed`);
          }
          setTimeout(() => setDeleting(prev => { const n = { ...prev }; delete n[uid]; return n; }), 400);
          loadUsers();
        }
      } catch {
        // op expired / unreachable — drop the row instead of leaving a
        // phantom "Deleting account…" entry behind forever.
        stopDeletePoll(uid);
        setDeleting(prev => { const n = { ...prev }; delete n[uid]; return n; });
      }
    };
    tick();
    deletePollers.current[uid] = window.setInterval(tick, 700);
  }, [loadUsers, stopDeletePoll]);

  // Resume tracking of in-flight deletions after a page refresh — but only
  // ones recent enough to plausibly still be running; older stuck ops get
  // finalized server-side and would just poll forever.
  useEffect(() => {
    opsApi.recent('user_delete').then(ops => {
      ops.filter(o => o.status === 'running' && isRecentOp(o)).forEach(o => {
        setDeleting(prev => ({ ...prev, [o.owner]: { opId: o.op_id, email: o.message || 'deleted user', status: 'running', message: o.message, counts: o.counts } }));
        pollDeleteOp(o.owner, o.op_id, o.message || 'deleted user');
      });
    }).catch(() => {});
    return () => { Object.values(deletePollers.current).forEach(clearInterval); deletePollers.current = {}; };
  }, [pollDeleteOp]);

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

  const loadLocations = useCallback(async () => {
    setError('');
    try {
      setLocations((await locationsApi.list()).items);
    } catch (err: any) {
      setError(err?.message || 'Failed to load locations');
    }
  }, []);
  const loadEntryTypes = useCallback(async () => {
    setError('');
    try {
      setEntryTypes((await entryTypesApi.listAll()).items);
    } catch (err: any) {
      setError(err?.message || 'Failed to load entry types');
    }
  }, []);
  const loadIndustries = useCallback(async () => {
    setError('');
    try {
      const data = await industriesApi.list(false);
      setIndustries(data.items);
      if (data.items.length && !selectedIndustryId) setSelectedIndustryId(data.items[0].id);
    } catch (err: any) { setError(err?.message || 'Failed to load industries'); }
  }, [selectedIndustryId]);
  const loadCategories = useCallback(async (industryId: string | null) => {
    if (!industryId) { setCategories([]); return; }
    setError('');
    try { setCategories((await categoriesApi.listAll(industryId)).items); }
    catch (err: any) { setError(err?.message || 'Failed to load categories'); }
  }, []);

  useEffect(() => {
    loadUsers();
    loadHosts();
    loadAIProviders();
    loadModels();
    loadLocations();
    loadEntryTypes();
    loadIndustries();
  }, [loadUsers, loadHosts, loadAIProviders, loadModels, loadLocations, loadEntryTypes, loadIndustries]);
  useEffect(() => { if (selectedIndustryId) loadCategories(selectedIndustryId); }, [selectedIndustryId, loadCategories]);

  const addLocation = async () => {
    const name = locationInput.trim();
    if (!name) return;
    setSavingLocations(true);
    setError('');
    setNotice('');
    try {
      await locationsApi.create(name);
      setLocationInput('');
      setNotice(`Added location "${name}"`);
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Failed to add location');
    } finally {
      setSavingLocations(false);
    }
  };

  const toggleLocation = async (loc: { id: string; name: string; is_active: boolean }) => {
    setSavingLocations(true);
    setError('');
    setNotice('');
    try {
      await locationsApi.update(loc.id, { is_active: !loc.is_active });
      setNotice(loc.is_active ? `Deactivated "${loc.name}"` : `Activated "${loc.name}"`);
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Failed to update location');
    } finally {
      setSavingLocations(false);
    }
  };

  const deleteLocation = async (loc: { id: string; name: string; is_active: boolean }) => {
    if (!(await confirm({
      title: 'Delete location?',
      message: (
        <>
          Delete <strong>{loc.name}</strong>? Receipts keep their stored location text.
        </>
      ),
    }))) return;
    setSavingLocations(true);
    setError('');
    setNotice('');
    try {
      await locationsApi.remove(loc.id);
      setNotice(`Deleted "${loc.name}"`);
      toast.success('Location deleted', `"${loc.name}" was removed.`);
      await loadLocations();
    } catch (err: any) {
      setError(err?.message || 'Failed to delete location');
      toast.error('Delete failed', err?.message || 'Failed to delete location');
    } finally {
      setSavingLocations(false);
    }
  };

  const addEntryType = async () => {
    const name = entryTypeName.trim().toLowerCase().replace(/\s+/g, '_');
    const label = entryTypeLabel.trim() || name;
    if (!name) return;
    setSavingEntryTypes(true); setError(''); setNotice('');
    try {
      await entryTypesApi.create(name, label);
      setEntryTypeName(''); setEntryTypeLabel('');
      setNotice(`Added entry type "${label}"`);
      await loadEntryTypes();
    } catch (err: any) { setError(err?.message || 'Failed to add entry type'); }
    finally { setSavingEntryTypes(false); }
  };
  const toggleEntryType = async (et: { id: string; name: string; label: string; is_active: boolean }) => {
    setSavingEntryTypes(true); setError(''); setNotice('');
    try {
      await entryTypesApi.update(et.id, { is_active: !et.is_active });
      setNotice(et.is_active ? `Deactivated "${et.label}"` : `Activated "${et.label}"`);
      await loadEntryTypes();
    } catch (err: any) { setError(err?.message || 'Failed to update entry type'); }
    finally { setSavingEntryTypes(false); }
  };
  const deleteEntryType = async (et: { id: string; name: string; label: string; is_system: boolean }) => {
    if (et.is_system) { setError('System entry types cannot be deleted (deactivate instead)'); return; }
    if (!(await confirm({ title: 'Delete entry type?', message: <>Delete <strong>{et.label}</strong> ({et.name})? Receipts keep their stored type.</> }))) return;
    setSavingEntryTypes(true); setError(''); setNotice('');
    try { await entryTypesApi.remove(et.id); setNotice(`Deleted "${et.label}"`); toast.success('Entry type deleted', `"${et.label}" was removed.`); await loadEntryTypes(); }
    catch (err: any) { setError(err?.message || 'Failed to delete entry type'); toast.error('Delete failed', err?.message || 'Failed to delete entry type'); }
    finally { setSavingEntryTypes(false); }
  };
  const addIndustry = async () => {
    const name = industryInput.trim(); if (!name) return;
    setSavingIndustries(true); setError(''); setNotice('');
    try { await industriesApi.create(name, industryDesc.trim() || undefined); setIndustryInput(''); setIndustryDesc(''); setNotice(`Added industry "${name}"`); await loadIndustries(); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to add industry'); }
    finally { setSavingIndustries(false); }
  };
  const toggleIndustry = async (ind: { id: string; name: string; is_active: boolean }) => {
    setSavingIndustries(true); setError(''); setNotice('');
    try { await industriesApi.update(ind.id, { is_active: !ind.is_active }); setNotice(ind.is_active ? `Deactivated "${ind.name}"` : `Activated "${ind.name}"`); await loadIndustries(); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to update industry'); }
    finally { setSavingIndustries(false); }
  };
  const deleteIndustry = async (ind: { id: string; name: string; is_system: boolean }) => {
    if (ind.is_system) { setError('System industries cannot be deleted'); return; }
    if (!(await confirm({ title: 'Delete industry?', message: <>Delete <strong>{ind.name}</strong>? Must have no categories/receipts.</> }))) return;
    setSavingIndustries(true); setError(''); setNotice('');
    try { await industriesApi.remove(ind.id); setNotice(`Deleted "${ind.name}"`); toast.success('Industry deleted', `"${ind.name}" was removed.`); await loadIndustries(); if (selectedIndustryId===ind.id) setSelectedIndustryId(null); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to delete industry'); toast.error('Delete failed', err?.message || 'Failed to delete industry'); }
    finally { setSavingIndustries(false); }
  };
  const addCategory = async () => {
    if (!selectedIndustryId) { setError('Select an industry first'); return; }
    const name = categoryName.trim(); if (!name) return;
    setSavingCategories(true); setError(''); setNotice('');
    try { await categoriesApi.create(selectedIndustryId, name, categoryLabel.trim() || name, categoryParent || null); setCategoryName(''); setCategoryLabel(''); setCategoryParent(''); setNotice(`Added category "${name}"`); await loadCategories(selectedIndustryId); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to add category'); }
    finally { setSavingCategories(false); }
  };
  const toggleCategory = async (cat: { id: string; name: string; is_active: boolean }) => {
    setSavingCategories(true); setError(''); setNotice('');
    try { await categoriesApi.update(cat.id, { is_active: !cat.is_active }); setNotice(cat.is_active ? `Deactivated "${cat.name}"` : `Activated "${cat.name}"`); await loadCategories(selectedIndustryId!); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to update category'); }
    finally { setSavingCategories(false); }
  };
  const deleteCategory = async (cat: { id: string; name: string; is_system: boolean }) => {
    if (cat.is_system) { setError('System categories cannot be deleted (deactivate instead)'); return; }
    if (!(await confirm({ title: 'Delete category?', message: <>Delete <strong>{cat.name}</strong>? Must have no subcategories/receipts.</> }))) return;
    setSavingCategories(true); setError(''); setNotice('');
    try { await categoriesApi.remove(cat.id); setNotice(`Deleted "${cat.name}"`); toast.success('Category deleted', `"${cat.name}" was removed.`); await loadCategories(selectedIndustryId!); invalidateReferenceData(); }
    catch (err: any) { setError(err?.message || 'Failed to delete category'); toast.error('Delete failed', err?.message || 'Failed to delete category'); }
    finally { setSavingCategories(false); }
  };
  const parseCsvLine = (line: string): string[] => {
    const res: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        res.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    res.push(cur.trim());
    return res.map(c => c.replace(/^"|"$/g, '').trim());
  };
  const handleCategoryCsv = async (file: File) => {
    if (!selectedIndustryId) { setError('Select an industry first'); return; }
    setCsvUploading(true); setError(''); setNotice('');
    try {
      const raw = await file.text();
      // strip BOM
      const text = raw.replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      let start = 0;
      if (lines[0]) {
        const first = lines[0].toLowerCase();
        // header row like "name,label,parent" or "category,label" etc
        if (first.includes('name') || first.includes('category') || first.includes('label')) {
          const cols = parseCsvLine(lines[0]).map(c => c.toLowerCase());
          if (cols.includes('name') || cols.includes('category') || cols.includes('label')) start = 1;
        }
      }
      let ok = 0, skip = 0;
      const existing = new Set(categories.map(c => c.name.toLowerCase()));
      for (let i = start; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        const name = (cols[0] || '').trim();
        const label = (cols[1] || name).trim();
        const parentName = (cols[2] || '').trim();
        if (!name) { skip++; continue; }
        if (existing.has(name.toLowerCase())) { skip++; continue; }
        let parentId: string | null = null;
        if (parentName) {
          const parent = categories.find(c => c.name.toLowerCase() === parentName.toLowerCase() || c.label.toLowerCase() === parentName.toLowerCase());
          parentId = parent?.id || null;
        }
        try {
          await categoriesApi.create(selectedIndustryId, name, label, parentId);
          existing.add(name.toLowerCase());
          ok++;
        } catch { skip++; }
      }
      setNotice(`CSV import: ${ok} created, ${skip} skipped (duplicates/invalid)`);
      await loadCategories(selectedIndustryId);
      invalidateReferenceData();
    } catch (err: any) { setError(err?.message || 'CSV import failed'); }
    finally { setCsvUploading(false); if (csvInputRef.current) csvInputRef.current.value = ''; }
  };

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
      toast.error('Cannot delete your own account');
      return;
    }
    if (!(await confirm({
      title: 'Delete account?',
      message: (
        <>
          Delete <strong>{user.email}</strong>? This permanently removes their account
          and ALL their data (receipts, sessions, backups, images). This cannot be undone.
        </>
      ),
    }))) return;
    setError('');
    setNotice('');
    try {
      const opId = opsApi.newOpId();
      setDeleting(prev => ({ ...prev, [user.uid]: { opId, email: user.email, status: 'running', message: 'Deleting account…', counts: {} } }));
      await adminDeleteUser(user.uid, opId);
      pollDeleteOp(user.uid, opId, user.email);
      setNotice(`Deleting ${user.email}…`);
      toast.success('Account deletion started', `Purging ${user.email}'s data in the background.`);
      await loadUsers();
    } catch (err: any) {
      stopDeletePoll(user.uid);
      setDeleting(prev => { const n = { ...prev }; delete n[user.uid]; return n; });
      setError(err?.message || 'Failed to delete user');
      toast.error('Delete failed', err?.message || 'Failed to delete user');
    }
  };

  const openEdit = (user: AuthUser) => {
    setEditingUser(user);
    setEditEmail(user.email);
    setEditDisplayName(user.display_name || '');
    setEditIsAdmin(user.is_admin);
    setEditPassword('');
    setError('');
    setNotice('');
  };

  const closeEdit = () => {
    setEditingUser(null);
    setEditPassword('');
  };

  const handleSaveEdit = async () => {
    if (!editingUser) return;
    const payload: { email?: string; display_name?: string | null; is_admin?: boolean; password?: string } = {};
    const trimmedEmail = editEmail.trim().toLowerCase();
    if (trimmedEmail && trimmedEmail !== editingUser.email) payload.email = trimmedEmail;
    const trimmedName = editDisplayName.trim();
    // allow clearing display name
    if (trimmedName !== (editingUser.display_name || '')) payload.display_name = trimmedName || null;
    if (editIsAdmin !== editingUser.is_admin) payload.is_admin = editIsAdmin;
    if (editPassword) {
      if (editPassword.length < 8) { setError('Password must be at least 8 characters'); return; }
      payload.password = editPassword;
    }
    if (Object.keys(payload).length === 0) { closeEdit(); return; }
    setSavingEdit(true);
    setError('');
    setNotice('');
    try {
      const updated = await adminUpdateUser(editingUser.uid, payload);
      setUsers(prev => prev.map(u => u.uid === updated.uid ? updated : u));
      setNotice(`Updated ${updated.email}`);
      toast.success('User updated', `${updated.email} profile saved.`);
      // If admin edited their own account, keep auth store in sync
      if (updated.uid === currentUser?.uid) {
        const raw = localStorage.getItem('scan-app-user');
        if (raw) {
          try { const parsed = JSON.parse(raw); localStorage.setItem('scan-app-user', JSON.stringify({ ...parsed, ...updated })); }
          catch { localStorage.removeItem('scan-app-user'); } // corrupt cache: drop it rather than keep a stale profile
        }
        useAuthStore.setState({ user: { ...(currentUser as AuthUser), ...updated } });
      }
      closeEdit();
    } catch (err: any) {
      setError(err?.message || 'Failed to update user');
      toast.error('Update failed', err?.message || 'Failed to update user');
    } finally {
      setSavingEdit(false);
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

  const [activeTab, setActiveTab] = useState<'users' | 'security' | 'locations' | 'industries' | 'ai' | 'backups'>('users');

  // ── Backup limits (admin) ──
  const [backupLimitGB, setBackupLimitGB] = useState('5');
  const [backupLimitCount, setBackupLimitCount] = useState('3');
  const [backupLimitsSaving, setBackupLimitsSaving] = useState(false);

  const loadBackupLimits = useCallback(async () => {
    try {
      const limits = await settingsApi.getBackupLimits();
      setBackupLimitGB(String(Math.round(limits.max_backup_bytes_per_user / (1024 * 1024 * 1024) * 100) / 100));
      setBackupLimitCount(String(limits.max_backups_per_user));
    } catch (err: any) {
      setError(err?.message || 'Failed to load backup limits');
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'backups') loadBackupLimits();
  }, [activeTab, loadBackupLimits]);

  // Admin-only guard (after hooks: must not sit between hook calls)
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

  const saveBackupLimits = async () => {
    const gb = Number(backupLimitGB);
    const count = Number(backupLimitCount);
    if (isNaN(gb) || gb < 0) { setError('Enter a valid size in GB (0 = unlimited)'); return; }
    if (isNaN(count) || count < 0 || !Number.isInteger(count)) { setError('Enter a whole number for backups kept (0 = unlimited)'); return; }
    setBackupLimitsSaving(true); setNotice(''); setError('');
    try {
      const limits = await settingsApi.setBackupLimits(
        Math.round(gb * 1024 * 1024 * 1024), count,
      );
      setBackupLimitGB(String(limits.max_backup_bytes_per_user / (1024 * 1024 * 1024)));
      setBackupLimitCount(String(limits.max_backups_per_user));
      setNotice('Backup limits saved — applied to new exports immediately.');
    } catch (err: any) {
      setError(err?.message || 'Failed to save backup limits');
    } finally {
      setBackupLimitsSaving(false);
    }
  };

  const ADMIN_TABS = [
    { key: 'users', label: 'Users', icon: UserIcon },
    { key: 'security', label: 'Security', icon: Globe },
    { key: 'locations', label: 'Locations', icon: MapPin },
    { key: 'industries', label: 'Industries', icon: Database },
    { key: 'ai', label: 'AI Providers', icon: Key },
    { key: 'backups', label: 'Backups', icon: Database },
  ] as const;

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-6 sm:py-8">
      {deleteDialog}
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-800">Admin</h1>
            <p className="text-sm text-gray-500">Manage users, locations, network security, and AI providers.</p>
          </div>
          {activeTab === 'users' && (
            <button
              onClick={loadUsers}
              disabled={loadingUsers}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-white border border-gray-300 text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 ${loadingUsers ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b overflow-x-auto">
          {ADMIN_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <tab.icon className="h-4 w-4" />{tab.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">{error}</div>
        )}
        {notice && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">{notice}</div>
        )}

        {activeTab === 'users' && (
          <>
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
                  <th className="px-6 py-3 font-medium">Display Name</th>
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
                    <td className="px-6 py-3 text-gray-700">{u.display_name || <span className="text-gray-400">—</span>}</td>
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
                      <div className="inline-flex items-center gap-1">
                        <button
                          onClick={() => openEdit(u)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-blue-600 hover:bg-blue-50 text-sm transition-colors"
                        >
                          <Pencil className="h-4 w-4" /> Edit
                        </button>
                        <button
                          onClick={() => handleDelete(u)}
                          disabled={u.uid === userId}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-red-600 hover:bg-red-50 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="h-4 w-4" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {Object.values(deleting).map(d => (
                  <tr key={d.opId} className="border-b last:border-0 bg-amber-50/50">
                    <td className="px-6 py-3">
                      <span className="flex items-center gap-2">
                        <RefreshCw className={`h-4 w-4 text-amber-600 ${d.status === 'running' ? 'animate-spin' : ''}`} />
                        <span className="font-medium text-gray-800">{d.email}</span>
                      </span>
                    </td>
                    <td className="px-6 py-3 text-gray-400">—</td>
                    <td className="px-6 py-3">
                      <span className="text-xs bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">deleting</span>
                    </td>
                    <td className="px-6 py-3 text-gray-500">
                      {(d.counts.rows ?? 0)} rows · {(d.counts.images ?? 0)} files
                    </td>
                    <td className="px-6 py-3 text-right text-amber-600 text-xs truncate max-w-40">
                      {d.message}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && !loadingUsers && (
                  <tr>
                    <td colSpan={5} className="px-6 py-8 text-center text-gray-400">No users found</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        {editingUser && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeEdit}>
            <div onClick={e => e.stopPropagation()} className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <Pencil className="h-5 w-5 text-blue-600" /> Edit User
                </h3>
                <button onClick={closeEdit} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
              </div>
              <p className="text-xs text-gray-500">UID <code className="bg-gray-100 px-1 rounded">{editingUser.uid.slice(0, 12)}…</code> — leave password blank to keep existing.</p>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Email</label>
                  <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} className="w-full border border-gray-300 rounded-md p-2 text-sm" placeholder="user@example.com" />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Display Name</label>
                  <input type="text" value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} className="w-full border border-gray-300 rounded-md p-2 text-sm" placeholder="Optional" />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">New Password (optional)</label>
                  <input type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} minLength={8} className="w-full border border-gray-300 rounded-md p-2 text-sm" placeholder="Leave blank to keep current" />
                  {editPassword && editPassword.length < 8 && <p className="text-xs text-red-600 mt-1">Minimum 8 characters</p>}
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={editIsAdmin} onChange={e => setEditIsAdmin(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
                  Administrator
                  {editingUser.uid === userId && <span className="text-xs text-amber-600 ml-1">(you)</span>}
                </label>
                {editIsAdmin !== editingUser.is_admin && !editIsAdmin && (
                  <p className="text-xs text-amber-600">Demoting an admin — backend blocks removing the last admin.</p>
                )}
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={closeEdit} disabled={savingEdit} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm hover:bg-gray-50 disabled:opacity-50">Cancel</button>
                <button onClick={handleSaveEdit} disabled={savingEdit} className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
                  {savingEdit ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {savingEdit ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
          </>
        )}

        {activeTab === 'security' && (
          <>
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
          </>
        )}

        {activeTab === 'locations' && (
          <>
            {/* Locations reference data */}
        <div className="bg-white rounded-xl shadow p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
              <MapPin className="h-5 w-5 text-blue-600" /> Locations
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Shared list reviewers pick from when setting a receipt's location. A receipt must have
              a location before it can be approved as fully processed. Deactivating hides the option;
              receipts keep their stored text.
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={locationInput}
              onChange={e => setLocationInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLocation();
                }
              }}
              className="flex-1 border border-gray-300 rounded-md p-2 text-sm"
              placeholder="e.g. Nairobi HQ, Kampala Branch, Mombasa Store…"
            />
            <button
              onClick={addLocation}
              disabled={savingLocations || !locationInput.trim()}
              className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              <Plus className="h-4 w-4 inline -mt-0.5" /> Add
            </button>
          </div>

          {locations.length === 0 ? (
            <p className="text-sm text-gray-400">No locations yet — add the first one above.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {locations.map(loc => (
                <li key={loc.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className={`text-sm ${loc.is_active ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
                    {loc.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleLocation(loc)}
                      disabled={savingLocations}
                      className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                        loc.is_active
                          ? 'border-gray-300 text-gray-600 hover:bg-gray-50'
                          : 'border-green-300 text-green-700 hover:bg-green-50'
                      }`}
                    >
                      {loc.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => deleteLocation(loc)}
                      disabled={savingLocations}
                      className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* Entry Types reference data */}
        <div className="bg-white rounded-xl shadow p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
              <MapPin className="h-5 w-5 text-purple-600" /> Entry Types
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              Shared list for receipt entry type. Default <code className="text-xs bg-gray-100 px-1 rounded">expense</code> counts toward totals; others are retained but excluded. Deactivating hides the option; deleting is blocked for system types.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={entryTypeName}
              onChange={e => setEntryTypeName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntryType(); } }}
              className="flex-1 border border-gray-300 rounded-md p-2 text-sm"
              placeholder="value e.g. refund, credit_note"
            />
            <input
              type="text"
              value={entryTypeLabel}
              onChange={e => setEntryTypeLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntryType(); } }}
              className="flex-1 border border-gray-300 rounded-md p-2 text-sm"
              placeholder="Label e.g. Refund"
            />
            <button
              onClick={addEntryType}
              disabled={savingEntryTypes || !entryTypeName.trim()}
              className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              <Plus className="h-4 w-4 inline -mt-0.5" /> Add
            </button>
          </div>
          {entryTypes.length === 0 ? (
            <p className="text-sm text-gray-400">No entry types yet — add one above.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
              {entryTypes.map(et => (
                <li key={et.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span title={et.label} className={`text-sm min-w-0 truncate ${et.is_active ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
                    {et.label} <span className="text-xs text-gray-400 font-normal">({et.name})</span> {et.is_system && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">system</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleEntryType(et)}
                      disabled={savingEntryTypes}
                      className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${et.is_active ? 'border-gray-300 text-gray-600 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                    >
                      {et.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => deleteEntryType(et)}
                      disabled={savingEntryTypes || et.is_system}
                      className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:text-gray-400 disabled:border-gray-200"
                      title={et.is_system ? 'System types cannot be deleted' : 'Delete'}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
          </>
        )}

        {activeTab === 'industries' && (
          <>
            <div className="bg-white rounded-xl shadow p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <Database className="h-5 w-5 text-indigo-600" /> Industries
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Global industries. Create Hospitality, Construction etc. Each receipt and scan session must belong to one industry. Deactivating hides it from pickers.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input type="text" value={industryInput} onChange={e => setIndustryInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIndustry(); } }} className="flex-1 border border-gray-300 rounded-md p-2 text-sm" placeholder="e.g. Hospitality" />
                <input type="text" value={industryDesc} onChange={e => setIndustryDesc(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addIndustry(); } }} className="flex-1 border border-gray-300 rounded-md p-2 text-sm" placeholder="Description (optional)" />
                <button onClick={addIndustry} disabled={savingIndustries || !industryInput.trim()} className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 disabled:opacity-50"><Plus className="h-4 w-4 inline -mt-0.5" /> Add</button>
              </div>
              {industries.length === 0 ? <p className="text-sm text-gray-400">No industries yet — add one above.</p> : (
                <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                  {industries.map(ind => (
                    <li key={ind.id} className={`flex items-center justify-between gap-3 px-4 py-2.5 ${selectedIndustryId===ind.id ? 'bg-indigo-50' : ''}`}>
                      <button onClick={() => setSelectedIndustryId(ind.id)} className={`text-sm text-left flex-1 ${ind.is_active ? 'text-gray-800' : 'text-gray-400 line-through'} ${selectedIndustryId===ind.id ? 'font-semibold' : ''}`}>{ind.name} {ind.is_system && <span className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">system</span>} <span className="text-xs text-gray-400">{ind.description || ''}</span></button>
                      <div className="flex items-center gap-2">
                        <button onClick={() => toggleIndustry(ind)} disabled={savingIndustries} className={`text-xs px-2 py-1 rounded border ${ind.is_active ? 'border-gray-300 text-gray-600 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>{ind.is_active ? 'Deactivate' : 'Activate'}</button>
                        <button onClick={() => deleteIndustry(ind)} disabled={savingIndustries || ind.is_system} className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">{ind.is_system ? 'System' : 'Delete'}</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-white rounded-xl shadow p-6 space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                  <Database className="h-5 w-5 text-indigo-600" /> Categories {selectedIndustryId ? `for ${industries.find(i=>i.id===selectedIndustryId)?.name || ''}` : ''}
                  {selectedIndustryId && <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">{categories.length}</span>}
                </h2>
                <div className="flex gap-2 flex-wrap">
                  <input type="text" value={categorySearch} onChange={e => setCategorySearch(e.target.value)} placeholder="Search categories" className="px-2 py-1 border rounded text-sm" />
                  <input ref={csvInputRef} type="file" accept=".csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleCategoryCsv(f); }} />
                  <button onClick={() => csvInputRef.current?.click()} disabled={!selectedIndustryId || csvUploading} className="px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-700 text-xs hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1">
                    {csvUploading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Import CSV
                  </button>
                </div>
              </div>
              <p className="text-xs text-gray-400">CSV: <code className="bg-gray-100 px-1 rounded">name,label,parent</code> per line, header optional. Example: <code className="bg-gray-100 px-1 rounded">Beef,Beef,</code> or <code className="bg-gray-100 px-1 rounded">Pork,Pork,Meats</code></p>
              {!selectedIndustryId ? <p className="text-sm text-gray-400">Select an industry above to manage its categories.</p> : (
                <>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input type="text" value={categoryName} onChange={e => setCategoryName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }} className="flex-1 border border-gray-300 rounded-md p-2 text-sm" placeholder="Category name e.g. Beef" />
                    <input type="text" value={categoryLabel} onChange={e => setCategoryLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }} className="flex-1 border border-gray-300 rounded-md p-2 text-sm" placeholder="Label e.g. Beef" />
                    <select value={categoryParent} onChange={e => setCategoryParent(e.target.value)} className="flex-1 border border-gray-300 rounded-md p-2 text-sm bg-white">
                      <option value="">No parent (top-level)</option>
                      {categories.filter(c=>!c.parent_id).map(c => <option key={c.id} value={c.id} title={c.label}>{c.name || c.label}</option>)}
                    </select>
                    <button onClick={addCategory} disabled={savingCategories || !categoryName.trim()} className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm hover:bg-gray-100 disabled:opacity-50"><Plus className="h-4 w-4 inline -mt-0.5" /> Add</button>
                  </div>
                  {categories.filter(c => !categorySearch || c.name.toLowerCase().includes(categorySearch.toLowerCase()) || c.label.toLowerCase().includes(categorySearch.toLowerCase())).length === 0 ? <p className="text-sm text-gray-400">No categories yet — add one above.</p> : (
                    <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg">
                      {categories.filter(c => !categorySearch || c.name.toLowerCase().includes(categorySearch.toLowerCase()) || c.label.toLowerCase().includes(categorySearch.toLowerCase())).map(cat => (
                        <li key={cat.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <span title={cat.label} className={`text-sm min-w-0 truncate ${cat.is_active ? 'text-gray-800' : 'text-gray-400 line-through'} ${cat.parent_id ? 'ml-4 border-l-2 border-gray-200 pl-2' : ''}`}>{cat.name || cat.label} {cat.label && cat.label !== cat.name && <span className="text-xs text-gray-400 font-normal">— {cat.label}</span>} {cat.is_system && <span className="text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">system</span>} {cat.parent_id && <span className="text-[10px] text-gray-400">sub of {categories.find(p=>p.id===cat.parent_id)?.name || categories.find(p=>p.id===cat.parent_id)?.label}</span>}</span>
                          <div className="flex items-center gap-2">
                            <button onClick={() => toggleCategory(cat)} disabled={savingCategories} className={`text-xs px-2 py-1 rounded border ${cat.is_active ? 'border-gray-300 text-gray-600 hover:bg-gray-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}>{cat.is_active ? 'Deactivate' : 'Activate'}</button>
                            <button onClick={() => deleteCategory(cat)} disabled={savingCategories || cat.is_system} className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50">Delete</button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {activeTab === 'ai' && (
          <>
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
          </>
        )}

        {activeTab === 'backups' && (
          <div className="bg-white rounded-xl shadow p-6 space-y-5">
            <div>
              <h2 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
                <Database className="h-5 w-5 text-blue-600" /> Backup Storage Limits
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Backups are stored on the server shared across all users&apos; devices. Each user
                gets this per-user quota; when a new export would exceed it, the oldest backups are
                automatically removed. Applies immediately to new exports.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                  Max backup size per user (GB)
                </label>
                <p className="text-xs text-gray-400 mb-2">0 = unlimited</p>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={backupLimitGB}
                  onChange={e => setBackupLimitGB(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">
                  Backups kept per user
                </label>
                <p className="text-xs text-gray-400 mb-2">0 = unlimited</p>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={backupLimitCount}
                  onChange={e => setBackupLimitCount(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
</div>
            </div>

            <button
              onClick={saveBackupLimits}
              disabled={backupLimitsSaving}
              className="px-5 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {backupLimitsSaving ? 'Saving...' : 'Save Limits'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminPage;