import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { cleaningApi } from '../services/api';
import { lineTaxOf } from '../utils/itemTotals';
import { Sparkles, Merge, GitBranch, Copy, Trash2, CheckCircle, Loader2, AlertTriangle, Search, X, ChevronDown, ChevronRight, Image, Scale, ExternalLink } from 'lucide-react';
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

// Route all stored image URLs through the same cached proxy ImageViewer uses.
// /receipt-images/{id} is not a real route — only /api/images/cached?url=... serves bytes.
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const VALID_TABS: TabKey[] = ['suppliers', 'fields', 'duplicates', 'mismatches'];
  const tabFromUrl = searchParams.get('tab') as TabKey | null;
  const activeTab: TabKey = tabFromUrl && VALID_TABS.includes(tabFromUrl) ? tabFromUrl : 'suppliers';
  const setActiveTab = (t: TabKey) => setSearchParams({ tab: t }, { replace: true });

  useEffect(() => {
    if (!userId) return;
    fetchSuggestions();
  }, [userId]);

  const fetchSuggestions = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await cleaningApi.getSuggestions();
      setSuggestions(data);
    } catch (err: any) {
      setError(err.message || 'Failed to load suggestions');
    } finally {
      setLoading(false);
    }
  };

  const handleIgnore = async (type: string, group: any) => {
    try {
      const payload = { type, ...group };
      await cleaningApi.ignoreSuggestion(payload);
      await fetchSuggestions();
    } catch (err: any) {
      alert(err.message || 'Failed to dismiss');
    }
  };

  // Keep ONE supplier spelling separate from a merge cluster, so a wrong
  // variant in an otherwise-correct suggestion never blocks the rest.
  const excludeMergeVariant = async (variant: string) => {
    try {
      await cleaningApi.ignoreSuggestion({ type: 'merge_variant', value: variant });
      await fetchSuggestions();
    } catch (err: any) {
      alert(err.message || 'Failed to exclude this variant');
    }
  };

  const toggleAction = (id: string) => {
    setSelectedActions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllInGroup = (groupType: string, ids: string[]) => {
    setSelectedActions(prev => {
      const next = new Set(prev);
      for (const id of ids) next.add(`${groupType}:${id}`);
      return next;
    });
  };

  const deselectAllInGroup = (groupType: string, ids: string[]) => {
    setSelectedActions(prev => {
      const next = new Set(prev);
      for (const id of ids) next.delete(`${groupType}:${id}`);
      return next;
    });
  };

  const buildActions = (): CleaningAction[] => {
    if (!suggestions) return [];
    const actions: CleaningAction[] = [];

    for (const [idx, s] of (suggestions.supplier_merges || []).entries()) {
      if (selectedActions.has(`supplier_merge:${idx}`)) {
        actions.push({
          type: 'supplier_merge',
          canonical: s.canonical,
          receipt_ids: s.receipt_ids,
        });
      }
    }

    for (const [idx, s] of (suggestions.field_propagations || []).entries()) {
      if (selectedActions.has(`field_propagation:${idx}`)) {
        actions.push({
          type: 'field_propagation',
          field: s.field,
          value: s.value,
          target_receipts: s.target_receipts,
        });
      }
    }

    for (const [idx, d] of (suggestions.duplicates || []).entries()) {
      if (selectedActions.has(`duplicate:${idx}`)) {
        const deleteIds = d.receipts
          .filter((r: any) => r.id !== d.keep_id)
          .map((r: any) => r.id);
        actions.push({
          type: 'duplicate',
          keep_id: d.keep_id,
          delete_ids: deleteIds,
        });
      }
    }

    for (const [idx, m] of (suggestions.total_mismatches || []).entries()) {
      if (selectedActions.has(`total_mismatch:${idx}`)) {
        actions.push({
          type: 'total_recompute',
          keep_id: m.id,
          value: String(m.items_total),
        });
      }
    }

    return actions;
  };

  const handleApply = async () => {
    const actions = buildActions();
    if (actions.length === 0) return;
    setApplying(true);
    setResult(null);
    try {
      const res = await cleaningApi.applyActions(actions);
      setResult(res);
      setSelectedActions(new Set());
      await fetchSuggestions();
    } catch (err: any) {
      setError(err.message || 'Apply failed');
    } finally {
      setApplying(false);
    }
  };

  const actionCount = buildActions().length;
  const counts = useMemo(() => ({
    suppliers:  suggestions?.supplier_merges?.length || 0,
    fields:     suggestions?.field_propagations?.length || 0,
    duplicates: suggestions?.duplicates?.length || 0,
    mismatches: suggestions?.total_mismatches?.length || 0,
  }), [suggestions]);
  const totalSuggestions = counts.suppliers + counts.fields + counts.duplicates + counts.mismatches;

  useEffect(() => {
    if (!suggestions) return;
    if (counts[activeTab] > 0) return;
    const first = (Object.keys(counts) as TabKey[]).find(k => counts[k] > 0);
    if (first) setActiveTab(first);
  }, [suggestions, counts, activeTab]);

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
        <button onClick={fetchSuggestions} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
          Retry
        </button>
      </div>
    );
  }

  if (totalSuggestions === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
        <h2 className="text-xl font-bold text-gray-800 mb-2">All Clean!</h2>
        <p className="text-gray-500 mb-6">No data cleaning suggestions found. Your receipt data looks consistent.</p>
        <button onClick={fetchSuggestions} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">
          Scan Again
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Sparkles className="h-7 w-7 text-purple-600" />
          <h1 className="text-2xl font-bold text-gray-900">Data Cleaning</h1>
          <span className="text-sm bg-purple-100 text-purple-700 px-2.5 py-0.5 rounded-full font-medium">
            {totalSuggestions} suggestions
          </span>
        </div>
        <button onClick={fetchSuggestions} className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1">
          <Search className="h-3.5 w-3.5" /> Rescan
        </button>
      </div>

      {result && (
        <div className="mb-6 bg-green-50 border border-green-200 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-green-700">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium">
              Applied! {result.stats?.supplier_renames > 0 && `${result.stats.supplier_renames} renamed, `}
              {result.stats?.fields_filled > 0 && `${result.stats.fields_filled} fields filled, `}
              {result.stats?.duplicates_removed > 0 && `${result.stats.duplicates_removed} duplicates removed, `}
              {result.stats?.totals_recomputed > 0 && `${result.stats.totals_recomputed} totals updated from items`}
            </span>
          </div>
          <button onClick={() => setResult(null)} className="text-green-600 hover:text-green-800"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* ── Tab bar ── */}
      <div className="flex flex-wrap gap-1 mb-4 border-b border-gray-200">
        {TABS.map(t => {
          const Icon = t.icon;
          const n = counts[t.key];
          const isActive = activeTab === t.key;
          return (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                isActive
                  ? 'border-purple-500 text-purple-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}>
              <Icon className={`h-4 w-4 ${isActive ? t.iconClass : 'text-gray-400'}`} />
              <span>{t.label}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                n === 0 ? 'bg-gray-100 text-gray-400' : (isActive ? t.badgeActive : t.badgeIdle)
              }`}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* ── Detail mode toggle (Suppliers tab only) ── */}
      {activeTab === 'suppliers' && (
        <div className="flex gap-2 mb-4">
          <button onClick={() => setDetailMode('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${detailMode === 'all' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
            Select All / Group
          </button>
          <button onClick={() => setDetailMode('item')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${detailMode === 'item' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
            Item by Item
          </button>
        </div>
      )}

      <div className="space-y-6">
        {/* ── Supplier Merges ── */}
        {activeTab === 'suppliers' && suggestions.supplier_merges?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Merge className="h-4 w-4 text-orange-500" />
                <h2 className="font-semibold text-gray-800">Supplier Name Consolidation</h2>
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">{suggestions.supplier_merges.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('supplier_merge', suggestions.supplier_merges.map((_: any, i: number) => i))}
                  className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('supplier_merge', suggestions.supplier_merges.map((_: any, i: number) => i))}
                  className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.supplier_merges.map((cluster: any, idx: number) => {
                const actionId = `supplier_merge:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/50' : ''}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800">{cluster.canonical}</span>
                          <span className="text-xs text-gray-400">← will replace</span>
                          {cluster.variants.filter((v: string) => v !== cluster.canonical).map((v: string, vi: number) => (
                            <span key={vi} className="text-xs bg-orange-50 text-orange-700 border border-orange-200 px-1.5 py-0.5 rounded">
                              {v}
                              <span className="text-orange-400 ml-1">({(cluster.scores[vi + 1] * 100).toFixed(0)}%)</span>
                            </span>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">{cluster.receipt_ids.length} receipts affected</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('supplier_merge', cluster); }}
                        className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 flex-shrink-0"
                        title="Dismiss — not same supplier"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-3 pl-14">
                        <p className="text-xs text-gray-500 mb-2">All variants will be renamed to <strong>{cluster.canonical}</strong>:</p>
                        <div className="space-y-1">
                          {cluster.variants.map((v: string, vi: number) => (
                            <div key={vi} className="flex items-center gap-2 text-xs">
                              <span className="text-gray-400 w-16 text-right">{vi === 0 ? 'Keep' : `${(cluster.scores[vi] * 100).toFixed(0)}%`}</span>
                              <span className={`font-mono ${v === cluster.canonical ? 'text-green-700 font-semibold' : 'text-orange-600 line-through'}`}>
                                {v}
                              </span>
                              {v !== cluster.canonical && <span className="text-gray-400">→ {cluster.canonical}</span>}
                              <button
                                onClick={(e) => { e.stopPropagation(); excludeMergeVariant(v); }}
                                className="ml-auto p-0.5 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 flex-shrink-0"
                                title="Keep separate — this spelling is NOT the same supplier"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          ))}
                        </div>
                        <p className="text-[10px] text-gray-400 mt-2">
                          Click <X className="h-2.5 w-2.5 inline text-gray-400" /> on a variant to keep it separate, then select and apply the remaining merge.
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Field Propagation ── */}
        {activeTab === 'fields' && suggestions.field_propagations?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <GitBranch className="h-4 w-4 text-blue-500" />
                <h2 className="font-semibold text-gray-800">Field Propagation</h2>
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{suggestions.field_propagations.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('field_propagation', suggestions.field_propagations.map((_: any, i: number) => i))}
                  className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('field_propagation', suggestions.field_propagations.map((_: any, i: number) => i))}
                  className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.field_propagations.map((prop: any, idx: number) => {
                const actionId = `field_propagation:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/50' : ''}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                      </button>
                      <Copy className="h-4 w-4 text-blue-400" />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm text-gray-800">{prop.field}</span>
                        <span className="text-sm text-gray-600 mx-1">→</span>
                        <span className="font-mono text-sm text-blue-700">{prop.value}</span>
                        <span className="text-xs text-gray-500 ml-2">for {prop.supplier}</span>
                        <p className="text-xs text-gray-400 mt-0.5">{prop.target_receipts.length} receipts missing this field</p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('field_propagation', prop); }}
                        className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 flex-shrink-0"
                        title="Dismiss"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-3 pl-14">
                        <p className="text-xs text-gray-500 mb-1">Filling <strong>{prop.field}</strong> = <code className="text-blue-700">{prop.value}</code> on {prop.target_receipts.length} receipts from <strong>{prop.supplier}</strong></p>
                        <p className="text-xs text-gray-400">Source: {prop.source_receipts.length} receipts with this value</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Duplicates ── */}
        {activeTab === 'duplicates' && suggestions.duplicates?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Copy className="h-4 w-4 text-red-500" />
                <h2 className="font-semibold text-gray-800">Duplicate Receipts</h2>
                <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">{suggestions.duplicates.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('duplicate', suggestions.duplicates.map((_: any, i: number) => i))}
                  className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('duplicate', suggestions.duplicates.map((_: any, i: number) => i))}
                  className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <div className="divide-y">
              {suggestions.duplicates.map((group: any, idx: number) => {
                const actionId = `duplicate:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const toDelete = group.receipts.filter((r: any) => r.id !== group.keep_id);
                return (
                  <div key={idx} className={`${isSelected ? 'bg-blue-50/50' : ''}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                      </button>
                      <Trash2 className="h-4 w-4 text-red-400" />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm text-gray-800">{group.receipts[0]?.supplier}</span>
                        <span className="text-xs text-gray-500 ml-2">{group.receipts.length} copies · keep 1</span>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {group.receipts.map((r: any) => r.totalAmount).filter((v: any, i: number, a: any) => a.indexOf(v) === i).join(', ')}
                        </p>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('duplicate', group); }}
                        className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 flex-shrink-0"
                        title="Dismiss — not a duplicate"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-3 pl-14 space-y-3">
                        <p className="text-xs font-medium text-green-700 flex items-center gap-1">
                          <CheckCircle className="h-3 w-3" /> Keep: <span className="font-mono">{group.receipts.find((r: any) => r.id === group.keep_id)?.supplier} — {group.receipts.find((r: any) => r.id === group.keep_id)?.totalAmount} ({group.receipts.find((r: any) => r.id === group.keep_id)?.receiptDate})</span>
                        </p>

                        {/* Image comparison grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                          {/* Keep image */}
                          {(() => {
                            const keep = group.receipts.find((r: any) => r.id === group.keep_id);
                            if (!keep?.imageUrl) return null;
                            return (
                              <button onClick={() => setCompareImage({ url: keep.imageUrl, label: 'Keep: ' + keep.supplier })}
                                className="relative group border-2 border-green-400 rounded-lg overflow-hidden aspect-[3/4] bg-gray-100 hover:shadow-md transition-shadow">
                                <img src={proxiedImageUrl(keep.imageUrl)} alt="Keep" className="w-full h-full object-cover" loading="lazy" />
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                                  <p className="text-[10px] text-white font-semibold truncate">✓ Keep</p>
                                </div>
                                <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors" />
                              </button>
                            );
                          })()}

                          {/* Delete images */}
                          {toDelete.map((r: any) => (
                            <button key={r.id} onClick={() => setCompareImage({ url: r.imageUrl, label: 'Remove: ' + r.supplier })}
                              className="relative group border-2 border-red-200 rounded-lg overflow-hidden aspect-[3/4] bg-gray-100 hover:shadow-md hover:border-red-400 transition-all">
                              {r.imageUrl ? (
                                <img src={proxiedImageUrl(r.imageUrl)} alt="Duplicate" className="w-full h-full object-cover" loading="lazy"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              ) : (
                                <div className="flex items-center justify-center h-full text-gray-300"><Image className="h-6 w-6" /></div>
                              )}
                              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5">
                                <p className="text-[10px] text-white truncate">{r.supplier}</p>
                                <p className="text-[9px] text-red-300">{r.totalAmount} · {(group.scores?.[group.receipts.indexOf(r)] || 0) * 100}%</p>
                              </div>
                              <div className="absolute top-1 right-1 bg-red-500 text-white text-[9px] px-1 rounded font-bold">✕</div>
                              <div className="absolute inset-0 bg-white/0 group-hover:bg-white/10 transition-colors" />
                            </button>
                          ))}
                        </div>

                        {/* Text list fallback */}
                        {toDelete.filter((r: any) => !r.imageUrl).length > 0 && (
                          <div className="space-y-1 pt-1">
                            {toDelete.filter((r: any) => !r.imageUrl).map((r: any) => (
                              <div key={r.id} className="flex items-center gap-2 text-xs text-red-600">
                                <Trash2 className="h-3 w-3" />
                                <span className="font-mono">{r.supplier} — {r.totalAmount} ({r.receiptDate})</span>
                                <span className="text-red-400">{(group.scores?.[group.receipts.indexOf(r)] || 0) * 100}%</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Total Mismatches ── */}
        {activeTab === 'mismatches' && suggestions.total_mismatches?.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
              <div className="flex items-center gap-2">
                <Scale className="h-4 w-4 text-amber-500" />
                <h2 className="font-semibold text-gray-800">Total ≠ Sum of Items</h2>
                <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">{suggestions.total_mismatches.length}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={() => selectAllInGroup('total_mismatch', suggestions.total_mismatches.map((_: any, i: number) => i))}
                  className="text-xs text-blue-600 hover:text-blue-800">Select all</button>
                <button onClick={() => deselectAllInGroup('total_mismatch', suggestions.total_mismatches.map((_: any, i: number) => i))}
                  className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
              </div>
            </div>
            <p className="px-5 py-2 text-xs text-gray-500 bg-amber-50/50 border-b border-amber-100">
              These receipts have a stored total that disagrees with the sum of their line items
              beyond rounding noise (deviation is shown as amount and % of the total — decimal drift
              like 1500 vs 1498.98 is ignored). Selecting one replaces <code>totalAmount</code> with
              the computed item-total — only approve when the items look right (large percentages
              often mean a misread unit price).
            </p>
            <div className="divide-y">
              {suggestions.total_mismatches.map((m: any, idx: number) => {
                const actionId = `total_mismatch:${idx}`;
                const isSelected = selectedActions.has(actionId);
                const isExpanded = expandedGroups.has(actionId);
                const sign = m.variance >= 0 ? '+' : '';
                const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const thumb = m.thumbnailUrl || m.imageUrl;
                return (
                  <div key={m.id} className={`${isSelected ? 'bg-blue-50/50' : ''}`}>
                    <div className="flex items-center gap-3 px-5 py-3">
                      <input type="checkbox" checked={isSelected} onChange={() => toggleAction(actionId)}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                      <button onClick={() => toggleGroup(actionId)} className="p-0.5 hover:bg-gray-100 rounded">
                        {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                      </button>
                      {thumb ? (
                        <button onClick={() => setCompareImage({ url: m.imageUrl || thumb, label: m.supplier })}
                          className="h-20 w-20 rounded border border-gray-200 overflow-hidden flex-shrink-0 bg-gray-100 hover:border-blue-400 hover:shadow-md transition-all">
                          <img src={proxiedImageUrl(thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
                        </button>
                      ) : (
                        <div className="h-20 w-20 rounded border border-gray-200 bg-gray-50 flex items-center justify-center flex-shrink-0">
                          <Image className="h-6 w-6 text-gray-300" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800 truncate">{m.supplier}</span>
                          <span className="text-xs text-gray-400">{m.receiptDate}</span>
                          {m.invoiceNumber && <span className="text-xs text-gray-400 font-mono">{m.invoiceNumber}</span>}
                          <span className="text-xs text-gray-400">· {m.n_items} item{m.n_items !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 text-xs">
                          <span className="text-gray-500">Receipt: <span className="font-mono text-gray-800">{fmt(m.receipt_total)}</span></span>
                          <span className="text-gray-300">→</span>
                          <span className="text-gray-500">Items: <span className="font-mono text-gray-800">{fmt(m.items_total)}</span></span>
                          <span className={`font-mono font-semibold ${m.variance > 0 ? 'text-red-600' : 'text-blue-600'}`}>
                            {sign}{fmt(m.variance)}
                            {typeof m.variance_pct === 'number' && (
                              <span className="text-gray-400 font-normal"> ({Math.abs(m.variance_pct).toFixed(2)}%)</span>
                            )}
                          </span>
                        </div>
                      </div>
                      <button
                        onClick={() => navigate(`/receipts/${m.id}?returnTo=${encodeURIComponent('/cleaning?tab=mismatches')}`)}
                        className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 flex-shrink-0"
                        title="Open receipt to edit (returns here on save/cancel)"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleIgnore('total_mismatch', { keep_id: m.id }); }}
                        className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 flex-shrink-0"
                        title="Dismiss — totals are intentional"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {isExpanded && (
                      <div className="px-5 pb-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4">
                        <div className="bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
                          {m.imageUrl ? (
                            <ImageViewer imageUrl={m.imageUrl} altText={m.supplier} containerClass="min-h-[24rem] max-h-[32rem]" />
                          ) : (
                            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
                              <Image className="h-10 w-10 mb-2" />
                              <p className="text-xs">No image on this receipt</p>
                            </div>
                          )}
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border border-gray-200 rounded">
                            <thead className="bg-gray-50 text-gray-600">
                              <tr>
                                <th className="px-2 py-1.5 text-left">#</th>
                                <th className="px-2 py-1.5 text-left">Item</th>
                                <th className="px-2 py-1.5 text-right">Qty</th>
                                <th className="px-2 py-1.5 text-right">Price</th>
                                <th className="px-2 py-1.5 text-right">Tax</th>
                                <th className="px-2 py-1.5 text-right">Line Total</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {(m.items || []).map((it: any, i: number) => (
                                <tr key={i} className="hover:bg-gray-50">
                                  <td className="px-2 py-1 text-gray-400">{i + 1}</td>
                                  <td className="px-2 py-1 truncate max-w-[14rem]">{it.name || '—'}</td>
                                  <td className="px-2 py-1 text-right font-mono">{it.quantity}</td>
                                  <td className="px-2 py-1 text-right font-mono">{fmt(it.price)}</td>
                                  <td className="px-2 py-1 text-right font-mono text-gray-500">{it.tax ? fmt(it.tax) : '—'}</td>
                                  <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(it.line_total)}</td>
                                </tr>
                              ))}
                              <tr className="bg-gray-50">
                                <td colSpan={5} className="px-2 py-1.5 text-right text-gray-600">Total tax (from items)</td>
                                <td className="px-2 py-1.5 text-right font-mono">
                                  {fmt((m.items || []).reduce((s: number, it: any) => s + lineTaxOf(it), 0))}
                                </td>
                              </tr>
                              <tr className="bg-gray-50 font-semibold">
                                <td colSpan={5} className="px-2 py-1.5 text-right text-gray-600">Items total</td>
                                <td className="px-2 py-1.5 text-right font-mono">{fmt(m.items_total)}</td>
                              </tr>
                              <tr className="bg-gray-50">
                                <td colSpan={5} className="px-2 py-1.5 text-right text-gray-600">Receipt total</td>
                                <td className="px-2 py-1.5 text-right font-mono">{fmt(m.receipt_total)}</td>
                              </tr>
                              <tr className={m.variance > 0 ? 'bg-red-50' : 'bg-blue-50'}>
                                <td colSpan={5} className="px-2 py-1.5 text-right font-semibold text-gray-700">Variance</td>
                                <td className={`px-2 py-1.5 text-right font-mono font-bold ${m.variance > 0 ? 'text-red-700' : 'text-blue-700'}`}>
                                  {sign}{fmt(m.variance)}
                                  {typeof m.variance_pct === 'number' && (
                                    <span className="text-gray-500 font-normal"> ({Math.abs(m.variance_pct).toFixed(2)}%)</span>
                                  )}
                                </td>
                              </tr>
                            </tbody>
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

        {/* ── Empty-tab placeholder ── */}
        {counts[activeTab] === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-12 text-center">
            <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-3" />
            <p className="text-sm text-gray-500">Nothing to clean in this category.</p>
          </div>
        )}
      </div>

      {/* ── Image comparison modal ── */}
      {compareImage && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4" onClick={() => setCompareImage(null)}>
          <div className="relative max-w-2xl w-full max-h-[90vh]" onClick={e => e.stopPropagation()}>
            <button onClick={() => setCompareImage(null)}
              className="absolute -top-8 right-0 text-white/70 hover:text-white text-sm flex items-center gap-1">
              <X className="h-4 w-4" /> Close
            </button>
            <p className="text-white/80 text-sm mb-2 truncate">{compareImage.label}</p>
            <ImageViewer imageUrl={compareImage.url} altText="Receipt" containerClass="min-h-[50vh] max-h-[80vh]" />
          </div>
        </div>
      )}

      {/* ── Apply bar ── */}
      <div className="sticky bottom-4 mt-6 bg-white border border-gray-200 rounded-xl shadow-lg p-4 flex items-center justify-between">
        <div>
          <p className="font-semibold text-gray-800">{actionCount} action{actionCount !== 1 ? 's' : ''} selected</p>
          <p className="text-xs text-gray-500">Review each suggestion before applying</p>
        </div>
        <button
          onClick={handleApply}
          disabled={actionCount === 0 || applying}
          className="flex items-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-700 disabled:bg-gray-300 disabled:text-gray-500 transition-all"
        >
          {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {applying ? 'Applying…' : `Apply ${actionCount} Change${actionCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );
};

export default DataCleaningPage;
