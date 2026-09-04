import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cleaningApi } from '../services/api';
import { lineTaxOf } from '../utils/itemTotals';
import { Sparkles, Merge, GitBranch, Copy, Trash2, CheckCircle, Loader2, AlertTriangle, Search, X, ChevronDown, ChevronRight, Image, Scale, ExternalLink, Ban, EyeOff } from 'lucide-react';
import ImageViewer from '../components/ImageViewer';

interface CleaningAction {
  type: 'supplier_merge' | 'field_propagation' | 'duplicate' | 'total_recompute';
  canonical?: string;
  variants?: string[];
  field?: string;
  value?: string;
  receipt_ids?: string[];
  target_receipts?: string[];
  keep_id?: string;
  delete_ids?: string[];
}

type TabKey = 'suppliers' | 'fields' | 'duplicates' | 'mismatches';

const TABS: { key: TabKey; label: string; icon: any; iconClass: string; badgeActive: string; badgeIdle: string }[] = [
  { key: 'suppliers',  label: 'Suppliers',        icon: Merge,     iconClass: 'text-orange-500', badgeActive: 'bg-orange-100 text-orange-700', badgeIdle: 'bg-gray-100 text-gray-600' },
  { key: 'fields',     label: 'Field Fills',      icon: GitBranch, iconClass: 'text-blue-500',   badgeActive: 'bg-blue-100 text-blue-700',     badgeIdle: 'bg-gray-100 text-gray-600' },
  { key: 'duplicates', label: 'Duplicates',       icon: Copy,      iconClass: 'text-red-500',    badgeActive: 'bg-red-100 text-red-700',       badgeIdle: 'bg-gray-100 text-gray-600' },
  { key: 'mismatches', label: 'Total Mismatches', icon: Scale,     iconClass: 'text-amber-500',  badgeActive: 'bg-amber-100 text-amber-700',   badgeIdle: 'bg-gray-100 text-gray-600' },
];

const proxiedImageUrl = (url: string) => `/api/images/cached?url=${encodeURIComponent(url)}`;

const DataCleaningPage = ({ userId }: { userId: string | null }) => {
  const [suggestions, setSuggestions] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<'all' | 'item'>('all');
  const [compareImage, setCompareImage] = useState<{ url: string; label: string } | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const VALID_TABS: TabKey[] = ['suppliers', 'fields', 'duplicates', 'mismatches'];
  const tabFromUrl = searchParams.get('tab') as TabKey | null;
  const activeTab: TabKey = tabFromUrl && VALID_TABS.includes(tabFromUrl) ? tabFromUrl : 'suppliers';
  const setActiveTab = (t: TabKey) => setSearchParams({ tab: t }, { replace: true });

  useEffect(() => { if (!userId) return; fetchSuggestions(); }, [userId]);

  const fetchSuggestions = async () => {
    setLoading(true); setError(null);
    try { const data = await cleaningApi.getSuggestions(); setSuggestions(data); }
    catch (err: any) { setError(err.message || 'Failed to load suggestions'); }
    finally { setLoading(false); }
  };

  const counts = useMemo(() => ({
    suppliers:  suggestions?.supplier_merges?.length || 0,
    fields:     suggestions?.field_propagations?.length || 0,
    duplicates: suggestions?.duplicates?.length || 0,
    mismatches: suggestions?.total_mismatches?.length || 0,
  }), [suggestions]);
  const totalSuggestions = counts.suppliers + counts.fields + counts.duplicates + counts.mismatches;
  const actionCount = selectedActions.size;

  // optimistic helpers - no full refetch
  const removeSupplierMergeAt = (idx: number) => {
    setSuggestions((prev: any) => {
      if (!prev) return prev;
      const next = { ...prev, supplier_merges: prev.supplier_merges.filter((_: any, i: number) => i !== idx) };
      return next;
    });
    setSelectedActions(prev => { const n = new Set(prev); n.delete(`supplier_merge:${idx}`); const shifted = new Set<string>(); n.forEach(v => { const [t, i] = v.split(':'); const ni = Number(i); if (t==='supplier_merge' && ni>idx) shifted.add(`${t}:${ni-1}`); else shifted.add(v); }); return shifted; });
    setExpandedGroups(prev => { const n = new Set(prev); n.delete(`supplier_merge:${idx}`); return n; });
  };
  const removeFieldPropAt = (idx: number) => {
    setSuggestions((prev: any) => ({ ...prev, field_propagations: prev.field_propagations.filter((_: any, i: number) => i !== idx) }));
    setSelectedActions(prev => { const n = new Set(prev); n.delete(`field_propagation:${idx}`); const shifted = new Set<string>(); n.forEach(v => { const [t,i]=v.split(':'); const ni=Number(i); if(t==='field_propagation'&&ni>idx) shifted.add(`${t}:${ni-1}`); else shifted.add(v); }); return shifted; });
  };
  const removeDuplicateAt = (idx: number) => {
    setSuggestions((prev: any) => ({ ...prev, duplicates: prev.duplicates.filter((_: any, i: number) => i !== idx) }));
    setSelectedActions(prev => { const n = new Set(prev); n.delete(`duplicate:${idx}`); const shifted = new Set<string>(); n.forEach(v => { const [t,i]=v.split(':'); const ni=Number(i); if(t==='duplicate'&&ni>idx) shifted.add(`${t}:${ni-1}`); else shifted.add(v); }); return shifted; });
  };
  const removeMismatchAt = (idx: number) => {
    setSuggestions((prev: any) => ({ ...prev, total_mismatches: prev.total_mismatches.filter((_: any, i: number) => i !== idx) }));
    setSelectedActions(prev => { const n = new Set(prev); n.delete(`total_mismatch:${idx}`); const shifted = new Set<string>(); n.forEach(v => { const [t,i]=v.split(':'); const pre='total_mismatch'; if(v.startsWith(pre+':')){ const ni=Number(v.slice(pre.length+1)); if(ni>idx) shifted.add(`${pre}:${ni-1}`); else if(ni<idx) shifted.add(v);} else shifted.add(v); }); return shifted; });
  };

  const handleIgnore = async (type: string, group: any, idx: number) => {
    const key = `${type}:${idx}`;
    setDismissing(key);
    try {
      const payload: any = { type, ...group };
      await cleaningApi.ignoreSuggestion(payload);
      if (type==='supplier_merge') removeSupplierMergeAt(idx);
      else if (type==='field_propagation') removeFieldPropAt(idx);
      else if (type==='duplicate') removeDuplicateAt(idx);
      else if (type==='total_mismatch') removeMismatchAt(idx);
    } catch (err: any) { alert(err.message || 'Failed to dismiss'); }
    finally { setDismissing(null); }
  };

  const excludeMergeVariant = async (clusterIdx: number, variant: string) => {
    const key = `mergex:${clusterIdx}:${variant}`;
    setDismissing(key);
    try {
      await cleaningApi.ignoreSuggestion({ type: 'merge_variant', value: variant } as any);
      setSuggestions((prev: any) => {
        if (!prev) return prev;
        const cluster = prev.supplier_merges[clusterIdx];
        if (!cluster) return prev;
        const kept = cluster.variants.filter((v: string) => v !== variant);
        if (kept.length < 2) {
          return { ...prev, supplier_merges: prev.supplier_merges.filter((_: any, i: number) => i !== clusterIdx) };
        }
        const scoreMap: Record<string, number> = {};
        cluster.variants.forEach((v: string, i: number) => scoreMap[v] = cluster.scores[i]);
        const vrids = cluster.variant_receipt_ids || {};
        const keptSorted = [...kept].sort((a,b) => (vrids[b]?.length||0)-(vrids[a]?.length||0));
        const canonical = kept.includes(cluster.canonical) ? cluster.canonical : keptSorted[0];
        const ordered = [canonical, ...keptSorted.filter((v: string) => v!==canonical)];
        const updated = { ...cluster, canonical, variants: ordered, scores: ordered.map((v: string)=>scoreMap[v]||0), receipt_ids: ordered.flatMap((v: string)=>vrids[v]||[]), variant_receipt_ids: Object.fromEntries(ordered.map((v: string)=>[v, vrids[v]||[]])) };
        const nextMerges = [...prev.supplier_merges]; nextMerges[clusterIdx]=updated;
        return { ...prev, supplier_merges: nextMerges };
      });
    } catch (err: any) { alert(err.message || 'Failed to exclude'); }
    finally { setDismissing(null); }
  };

  const toggleAction = (id: string) => {
    setSelectedActions(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const selectAllInGroup = (groupType: string, ids: string[]) => {
    setSelectedActions(prev => { const n = new Set(prev); for (const id of ids) n.add(`${groupType}:${id}`); return n; });
  };
  const deselectAllInGroup = (groupType: string, ids: string[]) => {
    setSelectedActions(prev => { const n = new Set(prev); for (const id of ids) n.delete(`${groupType}:${id}`); return n; });
  };

  const buildActions = (): CleaningAction[] => {
    if (!suggestions) return [];
    const actions: CleaningAction[] = [];
    for (const [idx, s] of (suggestions.supplier_merges || []).entries()) {
      if (selectedActions.has(`supplier_merge:${idx}`)) actions.push({ type: 'supplier_merge', canonical: s.canonical, receipt_ids: s.receipt_ids });
    }
    for (const [idx, s] of (suggestions.field_propagations || []).entries()) {
      if (selectedActions.has(`field_propagation:${idx}`)) actions.push({ type: 'field_propagation', field: s.field, value: s.value, target_receipts: s.target_receipts });
    }
    for (const [idx, d] of (suggestions.duplicates || []).entries()) {
      if (selectedActions.has(`duplicate:${idx}`)) {
        const deleteIds = d.receipts.filter((r: any) => r.id !== d.keep_id).map((r: any) => r.id);
        actions.push({ type: 'duplicate', keep_id: d.keep_id, delete_ids: deleteIds });
      }
    }
    for (const [idx, m] of (suggestions.total_mismatches || []).entries()) {
      if (selectedActions.has(`total_mismatch:${idx}`)) actions.push({ type: 'total_recompute', keep_id: m.id, value: String(m.items_total) });
    }
    return actions;
  };

  const handleApply = async () => {
    const actions = buildActions();
    if (actions.length === 0) return;
    setApplying(true); setResult(null);
    try {
      const res = await cleaningApi.applyActions(actions);
      setResult(res);
      // optimistic removal of applied items only, no full refetch
      const appliedIdx = {
        supplier_merge: new Set([...selectedActions].filter(s=>s.startsWith('supplier_merge:')).map(s=>Number(s.split(':')[1]))),
        field_propagation: new Set([...selectedActions].filter(s=>s.startsWith('field_propagation:')).map(s=>Number(s.split(':')[1]))),
        duplicate: new Set([...selectedActions].filter(s=>s.startsWith('duplicate:')).map(s=>Number(s.split(':')[1]))),
        total_mismatch: new Set([...selectedActions].filter(s=>s.startsWith('total_mismatch:')).map(s=>Number(s.split(':')[1]))),
      };
      setSuggestions((prev: any) => {
        if (!prev) return prev;
        return {
          ...prev,
          supplier_merges: prev.supplier_merges.filter((_: any,i:number)=>!appliedIdx.supplier_merge.has(i)),
          field_propagations: prev.field_propagations.filter((_: any,i:number)=>!appliedIdx.field_propagation.has(i)),
          duplicates: prev.duplicates.filter((_: any,i:number)=>!appliedIdx.duplicate.has(i)),
          total_mismatches: prev.total_mismatches.filter((_: any,i:number)=>!appliedIdx.total_mismatch.has(i)),
        };
      });
      setSelectedActions(new Set());
    } catch (err: any) { setError(err.message || 'Apply failed'); }
    finally { setApplying(false); }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-4rem)]">
        <div className="text-center space-y-3">
          <Loader2 className="h-8 w-8 animate-spin text-blue-500 mx-auto" />
          <p className="text-sm text-gray-500">Scanning receipts for cleaning opportunities…</p>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <AlertTriangle className="h-12 w-12 text-red-400 mx-auto mb-4" />
        <p className="text-red-600 mb-4">{error}</p>
        <button onClick={fetchSuggestions} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Retry</button>
      </div>
    );
  }
  if (totalSuggestions === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-gray-800 mb-2">All Clean!</h2>
        <p className="text-gray-500 mb-6">No data cleaning suggestions found. Your receipt data looks consistent.</p>
        <button onClick={fetchSuggestions} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Scan Again</button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-7 w-7 text-purple-600" />
          <h1 className="text-2xl font-bold text-gray-900">Data Cleaning</h1>
          <span className="text-sm bg-purple-100 text-purple-700 px-2.5 py-0.5 rounded-full font-medium">{totalSuggestions} suggestions</span>
          {actionCount>0 && <span className="text-sm bg-blue-100 text-blue-700 px-2.5 py-0.5 rounded-full font-medium">{actionCount} selected</span>}
        </div>
        <button onClick={fetchSuggestions} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"><Search className="h-3.5 w-3.5" /> Rescan</button>
      </div>

      {result && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium">
              Applied! {result.stats?.supplier_renames > 0 && `${result.stats.supplier_renames} renamed, `}
              {result.stats?.fields_filled > 0 && `${result.stats.fields_filled} fields filled, `}
              {result.stats?.duplicates_removed > 0 && `${result.stats.duplicates_removed} duplicates removed, `}
              {result.stats?.totals_recomputed > 0 && `${result.stats.totals_recomputed} totals updated`}
            </span>
          </div>
          <button onClick={() => setResult(null)} className="text-green-600 hover:text-green-800"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex flex-wrap gap-1 mb-4 border-b border-gray-200">
        {TABS.map(t => {
          const Icon = t.icon;
          const n = counts[t.key];
          const isActive = activeTab === t.key;
          return (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${isActive ? 'border-purple-500 text-purple-700' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
              <Icon className={`h-4 w-4 ${isActive ? t.iconClass : 'text-gray-400'}`} />
              <span>{t.label}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${n === 0 ? 'bg-gray-100 text-gray-400' : (isActive ? t.badgeActive : t.badgeIdle)}`}>{n}</span>
            </button>
          );
        })}
      </div>

      {activeTab === 'suppliers' && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setDetailMode('all')} className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${detailMode === 'all' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>Select All / Group</button>
          <button onClick={() => setDetailMode('item')} className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${detailMode === 'item' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>Item by Item</button>
        </div>
      )}

      <div className="space-y-6">
        {/* Suppliers */}
        {activeTab === 'suppliers' && suggestions.supplier_merges?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Merge className="h-4 w-4 text-orange-500" />
                <h2 className="font-semibold text-gray-800">Supplier Name Consolidation</h2>
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">{suggestions.supplier_merges.length}</span>
                <span className="text-xs text-gray-400 ml-2">{actionCount} selected</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('supplier_merge', suggestions.supplier_merges.map((_: any, i: number) => i))} className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('supplier_merge', suggestions.supplier_merges.map((_: any, i: number) => i))} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.supplier_merges.map((cluster: any, idx: number) => {
                const actionId = `supplier_merge:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const dismissKey = `supplier_merge:${idx}`;
                const isDismissing = dismissing === dismissKey;
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'} transition-colors`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">{isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}</button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800">{cluster.canonical}</span>
                          <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium">KEEP</span>
                          <span className="text-xs text-gray-400">← will replace {cluster.variants.length-1} variant{cluster.variants.length>2?'s':''}</span>
                          {cluster.variants.filter((v: string) => v !== cluster.canonical).map((v: string, vi: number) => (
                            <span key={vi} className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-1.5 py-0.5 rounded">
                              {v}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{cluster.receipt_ids.length} receipts will change • {isSelected ? '✓ Selected for merge' : 'Not selected'}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{isSelected ? 'SELECTED' : 'UNSELECTED'}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleIgnore('supplier_merge', cluster, idx); }}
                          disabled={isDismissing}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 bg-white text-xs text-gray-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
                          title="Dismiss group permanently — won't be suggested again"
                        >
                          {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} Not same
                        </button>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-3 pl-14">
                        <div className="bg-gray-50 rounded-lg border p-3 space-y-1.5">
                          <p className="text-xs font-medium text-gray-600">Preview — what will change:</p>
                          {cluster.variants.map((v: string, vi: number) => (
                            <div key={vi} className="flex items-center gap-2 text-xs">
                              <span className="w-20 text-right text-gray-400">{v===cluster.canonical ? 'KEEP' : 'RENAME'}</span>
                              <span className={`font-mono px-1.5 py-0.5 rounded ${v===cluster.canonical ? 'bg-green-100 text-green-800 font-semibold' : 'bg-orange-100 text-orange-700 line-through'}`}>{v}</span>
                              {v!==cluster.canonical && <><span className="text-gray-400">→</span><span className="font-mono bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">{cluster.canonical}</span></>}
                              <span className="text-gray-400 ml-auto">{cluster.variant_receipt_ids?.[v]?.length || 0} receipts</span>
                              {v !== cluster.canonical && (
                                <button
                                  onClick={() => excludeMergeVariant(idx, v)}
                                  disabled={dismissing===`mergex:${idx}:${v}`}
                                  className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 bg-white text-[11px] text-gray-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
                                  title="Keep this spelling separate forever"
                                >
                                  {dismissing===`mergex:${idx}:${v}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <EyeOff className="h-3 w-3" />} Keep separate
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        <p className="text-[11px] text-gray-400 mt-2">Tip: Use “Keep separate” on a single variant to exclude it without dismissing the whole group.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Field Propagation */}
        {activeTab === 'fields' && suggestions.field_propagations?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-blue-500" />
                <h2 className="font-semibold text-gray-800">Field Propagation</h2>
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{suggestions.field_propagations.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('field_propagation', suggestions.field_propagations.map((_: any, i: number) => i))} className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('field_propagation', suggestions.field_propagations.map((_: any, i: number) => i))} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.field_propagations.map((prop: any, idx: number) => {
                const actionId = `field_propagation:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const isDismissing = dismissing===`field_propagation:${idx}`;
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">{isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}</button>
                      <Copy className="h-4 w-4 text-blue-400" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800">{prop.field}</span>
                          <span className="text-sm text-gray-600 mx-1">→</span>
                          <span className="font-mono text-sm text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">{prop.value}</span>
                          <span className="text-xs text-gray-500">for {prop.supplier}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{isSelected ? 'SELECTED' : 'UNSELECTED'}</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{prop.target_receipts.length} receipts missing this field • Source: {prop.source_receipts.length} receipts</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('field_propagation', prop, idx); }}
                        disabled={isDismissing}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 bg-white text-xs text-gray-600 hover:bg-red-50 hover:text-red-600 hover:border-red-200 disabled:opacity-50"
                        title="Don't fill this field for this supplier again"
                      >
                        {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} Don't fill
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="mx-5 mb-3 bg-gray-50 rounded-lg border p-3">
                        <p className="text-xs text-gray-600">Filling <strong>{prop.field}</strong> = <code className="text-blue-700 bg-white px-1 py-0.5 rounded border">{prop.value}</code> on {prop.target_receipts.length} receipts from <strong>{prop.supplier}</strong>. Will not overwrite existing values.</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Duplicates */}
        {activeTab === 'duplicates' && suggestions.duplicates?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Copy className="h-4 w-4 text-red-500" />
                <h2 className="font-semibold text-gray-800">Duplicate Receipts</h2>
                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{suggestions.duplicates.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('duplicate', suggestions.duplicates.map((_: any, i: number) => i))} className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('duplicate', suggestions.duplicates.map((_: any, i: number) => i))} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.duplicates.map((group: any, idx: number) => {
                const actionId = `duplicate:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const toDelete = group.receipts.filter((r: any) => r.id !== group.keep_id);
                const isDismissing = dismissing===`duplicate:${idx}`;
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">{isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}</button>
                      <Trash2 className="h-4 w-4 text-red-400" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-gray-800">{group.receipts[0]?.supplier}</span>
                          <span className="text-xs text-gray-500">{group.receipts.length} copies • keep 1 delete {toDelete.length}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-500'}`}>{isSelected ? 'SELECTED TO DELETE' : 'UNSELECTED'}</span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">Keep most complete; {toDelete.length} will be removed on Apply</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('duplicate', group, idx); }}
                        disabled={isDismissing}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 bg-white text-xs text-gray-600 hover:bg-amber-50 hover:text-amber-700 hover:border-amber-200 disabled:opacity-50"
                        title="Keep all copies — not duplicates, don't suggest again for this exact pair"
                      >
                        {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />} Keep all
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-3 pl-14 space-y-3">
                        <div className="flex items-center gap-2 text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded px-3 py-2">
                          <CheckCircle className="h-3 w-3" /> Keep: {group.receipts.find((r: any) => r.id === group.keep_id)?.supplier} — {group.receipts.find((r: any) => r.id === group.keep_id)?.totalAmount} ({group.receipts.find((r: any) => r.id === group.keep_id)?.receiptDate})
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                          {toDelete.map((r: any) => (
                            <div key={r.id} className="relative border-2 border-red-200 rounded-lg overflow-hidden aspect-[3/4] bg-gray-100">
                              {r.imageUrl ? <img src={proxiedImageUrl(r.imageUrl)} alt="Duplicate" className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <div className="flex items-center justify-center h-full text-gray-300"><Image className="h-6 w-6" /></div>}
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                                <p className="text-[10px] text-white truncate">{r.supplier}</p>
                                <p className="text-[9px] text-red-300">Will delete • {r.totalAmount}</p>
                              </div>
                              <div className="absolute top-1 right-1 bg-red-500 text-white text-[9px] px-1 rounded font-bold">✕ DELETE</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Mismatches */}
        {activeTab === 'mismatches' && suggestions.total_mismatches?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-amber-500" />
                <h2 className="font-semibold text-gray-800">Total ≠ Sum of Items</h2>
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{suggestions.total_mismatches.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('total_mismatch', suggestions.total_mismatches.map((_: any, i: number) => i))} className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('total_mismatch', suggestions.total_mismatches.map((_: any, i: number) => i))} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.total_mismatches.map((m: any, idx: number) => {
                const actionId = `total_mismatch:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const sign = m.variance >= 0 ? '+' : '';
                const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const thumb = m.thumbnailUrl || m.imageUrl;
                const isDismissing = dismissing===`total_mismatch:${idx}`;
                return (
                  <div key={m.id} className={`${isSelected ? 'bg-blue-50/60 ring-1 ring-inset ring-blue-200' : 'hover:bg-gray-50'}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)} className="h-4 w-4 rounded border-gray-300 text-blue-600" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">{isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}</button>
                      {thumb ? (
                        <button onClick={() => setCompareImage({ url: m.imageUrl || thumb, label: m.supplier })} className="h-16 w-16 rounded border border-gray-200 overflow-hidden flex-shrink-0 bg-gray-100 hover:border-blue-400">
                          <img src={proxiedImageUrl(thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
                        </button>
                      ) : (
                        <div className="h-16 w-16 rounded border border-gray-200 bg-gray-50 flex items-center justify-center flex-shrink-0"><Image className="h-6 w-6 text-gray-300" /></div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800 truncate">{m.supplier}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${isSelected ? 'bg-blue-600 text-white' : 'bg-amber-100 text-amber-700'}`}>{isSelected ? 'SELECTED TO FIX' : `${sign}${fmt(m.variance)}`}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs">
                          <span className="text-gray-500">Receipt: <span className="font-mono text-gray-800">{fmt(m.receipt_total)}</span></span>
                          <span className="text-gray-300">→</span>
                          <span className="text-gray-500">Items: <span className="font-mono text-gray-800">{fmt(m.items_total)}</span></span>
                        </div>
                        <p className="text-xs text-gray-400">{m.receiptDate} • {m.n_items} items • {isSelected ? 'Will update receipt total to items total' : 'Totals disagree'}</p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => navigate(`/receipts/${m.id}?returnTo=${encodeURIComponent('/cleaning?tab=mismatches')}`)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700" title="Open receipt"><ExternalLink className="h-3.5 w-3.5" /></button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleIgnore('total_mismatch', { keep_id: m.id } as any, idx); }}
                          disabled={isDismissing}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 bg-white text-xs text-gray-600 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                          title="Ignore this mismatch — don't suggest again for this receipt"
                        >
                          {isDismissing ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Ignore
                        </button>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4">
                        <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
                          {m.imageUrl ? <ImageViewer imageUrl={m.imageUrl} altText={m.supplier} containerClass="min-h-[24rem] max-h-[32rem]" fileType={(m as any).fileType} /> : <div className="flex flex-col items-center justify-center h-64 text-gray-400"><Image className="h-10 w-10 mb-2" /><p className="text-xs">No image</p></div>}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border border-gray-200 rounded">
                            <thead className="bg-gray-50 text-gray-600"><tr><th className="px-2 py-1.5 text-left">#</th><th className="px-2 py-1.5 text-left">Item</th><th className="px-2 py-1.5 text-right">Qty</th><th className="px-2 py-1.5 text-right">Price</th><th className="px-2 py-1.5 text-right">Tax</th><th className="px-2 py-1.5 text-right">Line Total</th></tr></thead>
                            <tbody className="divide-y">{(m.items || []).map((it: any, i: number) => (<tr key={i} className="hover:bg-gray-50"><td className="px-2 py-1 text-gray-400">{i + 1}</td><td className="px-2 py-1 truncate max-w-[14rem]">{it.name || '—'}</td><td className="px-2 py-1 text-right font-mono">{it.quantity}</td><td className="px-2 py-1 text-right font-mono">{fmt(it.price)}</td><td className="px-2 py-1 text-right font-mono text-gray-500">{it.tax ? fmt(it.tax) : '—'}</td><td className="px-2 py-1 text-right font-mono font-semibold">{fmt(it.line_total)}</td></tr>))}<tr className="bg-gray-50"><td colSpan={5} className="px-2 py-1.5 text-right text-gray-600">Items total</td><td className="px-2 py-1.5 text-right font-mono">{fmt(m.items_total)}</td></tr><tr className="bg-gray-50"><td colSpan={5} className="px-2 py-1.5 text-right text-gray-600">Receipt total</td><td className="px-2 py-1.5 text-right font-mono">{fmt(m.receipt_total)}</td></tr><tr className={m.variance > 0 ? 'bg-red-50' : 'bg-blue-50'}><td colSpan={5} className="px-2 py-1.5 text-right font-semibold text-gray-700">Variance</td><td className={`px-2 py-1.5 text-right font-mono font-bold ${m.variance > 0 ? 'text-red-700' : 'text-blue-700'}`}>{sign}{fmt(m.variance)}</td></tr></tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {counts[activeTab] === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center">
            <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Nothing to clean in this category.</p>
            <p className="text-xs text-gray-400 mt-1">{actionCount} selected across all tabs will still apply</p>
          </div>
        )}
      </div>

      {compareImage && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={() => setCompareImage(null)}>
          <div className="relative max-w-2xl w-full max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <button onClick={() => setCompareImage(null)} className="absolute -top-8 right-0 text-white/70 hover:text-white text-sm flex items-center gap-1"><X className="h-4 w-4" /> Close</button>
            <p className="text-white/80 text-sm mb-2 truncate">{compareImage.label}</p>
            <ImageViewer imageUrl={compareImage.url} altText="Receipt" containerClass="min-h-[50vh] max-h-[80vh]" />
          </div>
        </div>
      )}

      <div className="sticky bottom-4 mt-6 bg-white border border-gray-200 rounded-xl shadow-lg p-4 flex items-center justify-between">
        <div>
          <p className="font-semibold text-gray-800">{actionCount} action{actionCount !== 1 ? 's' : ''} selected</p>
          <p className="text-xs text-gray-500">{totalSuggestions - actionCount} remaining • {actionCount ? 'Will apply only selected' : 'Select items to apply'}</p>
        </div>
        <button onClick={handleApply} disabled={actionCount === 0 || applying} className="flex items-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:text-gray-500 transition-all">
          {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {applying ? 'Applying…' : `Apply ${actionCount} Change${actionCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
};

export default DataCleaningPage;
