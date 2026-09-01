import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { dashboardApi } from '../services/api';
import {
  Chart as ChartJS,
  ArcElement, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Filler,
} from 'chart.js';
import { Doughnut, Bar, Line } from 'react-chartjs-2';
import {
  Wallet, Receipt, TrendingUp, Package,
  Calendar, ChevronDown, Layers,
  Sparkles, AlertTriangle, Lightbulb, Zap, Target,
  CheckCircle2, Clock,
} from 'lucide-react';

ChartJS.register(
  ArcElement, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Filler,
);

// ── Types ────────────────────────────────────────────────────────────────────

type DateRange = 'all' | 'this_month' | 'last_month' | 'last_3_months' | 'this_year';

interface Overview {
  total_spent: number;
  total_receipts: number;
  total_items: number;
  avg_per_receipt: number;
  processed_count: number;
  review_count: number;
  batch_count: number;
  supplier_count: number;
  category_count: number;
  subtotal: number;
  tax_total: number;
  largest_receipt: number | null;
  avg_items_per_receipt: number;
  batch_titles: string[];
}

interface Trends {
  monthly: { month: string; month_label: string; total: number; count: number; avg_per_receipt: number }[];
  period_total: number;
  period_avg_monthly: number;
  best_month: { month_label: string; total: number } | null;
  worst_month: { month_label: string; total: number } | null;
  month_over_month_change: number | null;
}

interface Breakdown {
  categories: { category: string; total: number; count: number; percentage: number; avg_per_receipt: number }[];
  suppliers: { supplier: string; total: number; count: number; percentage: number; avg_per_receipt: number }[];
  top_category: { category: string; total: number; percentage: number } | null;
  top_supplier: { supplier: string; total: number } | null;
}

interface InsightsData {
  insights: { type: string; title: string; description: string; importance: string }[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'this_month', label: 'This Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_3_months', label: 'Last 3 Months' },
  { value: 'this_year', label: 'This Year' },
];

const CHART_COLORS = [
  '#6366f1', '#8b5cf6', '#a78bfa',
  '#3b82f6', '#60a5fa',
  '#10b981', '#34d399',
  '#f59e0b', '#fbbf24',
  '#ef4444', '#f87171',
  '#ec4899', '#f472b6',
  '#06b6d4', '#22d3ee',
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtMMDDYYYY(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatKES(n: number): string {
  return n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatKESCompact(n: number): string {
  if (n >= 1_000_000) return `KES ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `KES ${(n / 1_000).toFixed(1)}K`;
  return `KES ${n.toFixed(0)}`;
}

// ── Sub-components ───────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={`animate-pulse bg-gray-100 rounded-xl ${className || ''}`} />;
}

function StatCard({
  title, value, subtitle, icon: Icon, color,
}: {
  title: string; value: string; subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white border border-gray-100 p-5 shadow-sm hover:shadow-md transition-shadow duration-300">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{title}</p>
          <p className="text-2xl font-bold text-gray-900 tracking-tight truncate">{value}</p>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </div>
  );
}

function ChartCard({ title, subtitle, children, className }: {
  title: string; subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={`rounded-2xl bg-white border border-gray-100 shadow-sm ${className || ''}`}>
      <div className="px-5 pt-4 pb-1">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </div>
  );
}

function InsightIcon({ type }: { type: string }) {
  const cls = 'w-4 h-4 flex-shrink-0 mt-0.5';
  switch (type) {
    case 'spending_pattern': return <Target className={`${cls} text-indigo-500`} />;
    case 'anomaly': return <AlertTriangle className={`${cls} text-amber-500`} />;
    case 'trend': return <Zap className={`${cls} text-emerald-500`} />;
    case 'tip': return <Lightbulb className={`${cls} text-blue-500`} />;
    default: return <Sparkles className={`${cls} text-gray-400`} />;
  }
}

function importanceBadge(imp: string) {
  const map: Record<string, string> = {
    high: 'bg-red-50 text-red-700 border-red-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    low: 'bg-gray-50 text-gray-600 border-gray-200',
  };
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wider ${map[imp] || map.low}`}>
      {imp}
    </span>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

const DashboardPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();

  const [dateRange, setDateRange] = useState<DateRange>('all');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [trends, setTrends] = useState<Trends | null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [insights, setInsights] = useState<InsightsData | null>(null);

  const [loading, setLoading] = useState({ overview: false, trends: false, breakdown: false, insights: false });

  const [batchModal, setBatchModal] = useState(false);

  // ── Date filters ────────────────────────────────────────────────────────

  const dateFilters = useMemo(() => {
    const now = new Date();
    switch (dateRange) {
      case 'this_month':
        return { date_from: fmtMMDDYYYY(new Date(now.getFullYear(), now.getMonth(), 1)), date_to: fmtMMDDYYYY(now) };
      case 'last_month':
        return { date_from: fmtMMDDYYYY(new Date(now.getFullYear(), now.getMonth() - 1, 1)), date_to: fmtMMDDYYYY(new Date(now.getFullYear(), now.getMonth(), 0)) };
      case 'last_3_months':
        return { date_from: fmtMMDDYYYY(new Date(now.getFullYear(), now.getMonth() - 3, 1)), date_to: fmtMMDDYYYY(now) };
      case 'this_year':
        return { date_from: fmtMMDDYYYY(new Date(now.getFullYear(), 0, 1)), date_to: fmtMMDDYYYY(now) };
      default:
        return { date_from: undefined, date_to: undefined };
    }
  }, [dateRange]);

  // ── Fetch all 4 endpoints in parallel ───────────────────────────────────

  const fetchAll = useCallback(async () => {
    if (!userId) return;
    const { date_from, date_to } = dateFilters;

    setLoading({ overview: true, trends: true, breakdown: true, insights: true });

    const settle = <T,>(p: Promise<T>, on: (v: T) => void, key: keyof typeof loading) =>
      p.then(v => { on(v); return v; }).finally(() => setLoading(l => ({ ...l, [key]: false })));

    await Promise.all([
      settle(dashboardApi.overview(date_from, date_to), setOverview, 'overview'),
      settle(dashboardApi.trends(12, date_from, date_to), setTrends, 'trends'),
      settle(dashboardApi.breakdown(date_from, date_to), setBreakdown, 'breakdown'),
      settle(dashboardApi.insights(date_from, date_to), setInsights, 'insights'),
    ]);
  }, [userId, dateFilters]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Chart data ──────────────────────────────────────────────────────────

  const trendChart = useMemo(() => ({
    labels: trends?.monthly.map(t => t.month_label) ?? [],
    datasets: [{
      label: 'Spending',
      data: trends?.monthly.map(t => t.total) ?? [],
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.06)',
      fill: true,
      tension: 0.4,
      pointRadius: 3,
      pointBackgroundColor: '#6366f1',
      pointBorderColor: '#fff',
      pointBorderWidth: 2,
      borderWidth: 2,
    }],
  }), [trends]);

  const categoryChart = useMemo(() => ({
    labels: (breakdown?.categories ?? []).slice(0, 5).map(c => c.category),
    datasets: [{
      label: 'KES',
      data: (breakdown?.categories ?? []).slice(0, 5).map(c => c.total),
      backgroundColor: (breakdown?.categories ?? []).slice(0, 5).map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
      borderRadius: 6,
      borderSkipped: false,
    }],
  }), [breakdown]);

  const supplierChart = useMemo(() => ({
    labels: (breakdown?.suppliers ?? []).slice(0, 5).map(s => s.supplier),
    datasets: [{
      label: 'KES',
      data: (breakdown?.suppliers ?? []).slice(0, 5).map(s => s.total),
      backgroundColor: (breakdown?.suppliers ?? []).slice(0, 5).map((_, i) => CHART_COLORS[(i + 3) % CHART_COLORS.length]),
      borderRadius: 6,
      borderSkipped: false,
    }],
  }), [breakdown]);

  const statusChart = useMemo(() => ({
    labels: ['Processed', 'Needs Review'],
    datasets: [{
      data: [overview?.processed_count ?? 0, overview?.review_count ?? 0],
      backgroundColor: ['#10b981', '#f59e0b'],
      borderColor: '#fff',
      borderWidth: 3,
    }],
  }), [overview]);

  // ── Chart options ───────────────────────────────────────────────────────

  const barOpts = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1f2937', cornerRadius: 8, padding: 10,
        callbacks: { label: (c: any) => ` KES ${Number(c.raw).toLocaleString()}` },
      },
    },
    scales: {
      x: { grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 }, callback: (v: any) => Number(v).toLocaleString('en-KE', { notation: 'compact', maximumFractionDigits: 1 }) } },
      y: { grid: { display: false }, ticks: { font: { size: 12 }, autoSkip: false } },
    },
  };

  const lineOpts = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1f2937', cornerRadius: 8, padding: 10,
        callbacks: { label: (c: any) => ` KES ${Number(c.raw).toLocaleString()}` },
      },
    },
    scales: {
      x: { grid: { color: '#f9fafb' }, ticks: { font: { size: 11 }, maxRotation: 45 } },
      y: { grid: { color: '#f3f4f6' }, ticks: { font: { size: 11 }, callback: (v: any) => Number(v).toLocaleString('en-KE', { notation: 'compact', maximumFractionDigits: 1 }) } },
    },
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 lg:p-8 w-full max-w-[1440px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            {overview ? `${overview.total_receipts} receipts analysed` : 'Loading...'}
          </p>
        </div>

        <div className="relative inline-flex items-center">
          <Calendar className="absolute left-3 w-4 h-4 text-gray-400 pointer-events-none" />
          <select
            value={dateRange}
            onChange={e => setDateRange(e.target.value as DateRange)}
            className="appearance-none pl-9 pr-8 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700 cursor-pointer hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-400 transition-colors"
          >
            {DATE_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <ChevronDown className="absolute right-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {loading.overview && !overview ? (
          [...Array(4)].map((_, i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <StatCard title="Total Spent" value={formatKESCompact(overview?.total_spent ?? 0)} icon={Wallet} color="bg-indigo-500/10 text-indigo-600" />
            <StatCard title="Receipts" value={String(overview?.total_receipts ?? 0)} subtitle={overview ? `${overview.processed_count} processed` : undefined} icon={Receipt} color="bg-emerald-500/10 text-emerald-600" />
            <StatCard title="Avg / Receipt" value={`KES ${formatKES(overview?.avg_per_receipt ?? 0)}`} icon={TrendingUp} color="bg-blue-500/10 text-blue-600" />
            <StatCard title="Total Items" value={String(overview?.total_items ?? 0)} subtitle={overview ? `${overview.avg_items_per_receipt} per receipt` : undefined} icon={Package} color="bg-amber-500/10 text-amber-600" />
          </>
        )}
      </div>

      {/* Trend + Insights */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ChartCard
            title="Monthly Spending"
            subtitle={trends?.best_month ? `Best: ${trends.best_month.month_label} (KES ${formatKESCompact(trends.best_month.total)})` : undefined}
          >
            {loading.trends ? <Skeleton className="h-[280px]" /> : (trendChart.labels.length > 0 ? (
              <div className="h-[280px]"><Line data={trendChart} options={lineOpts} /></div>
            ) : (
              <div className="h-[280px] flex items-center justify-center text-sm text-gray-400">No trend data for this period</div>
            ))}
          </ChartCard>
        </div>

        <div className="lg:col-span-1">
          <ChartCard title="Insights">
            {loading.insights ? (
              <Skeleton className="h-[280px]" />
            ) : (
              <div className="h-[280px] overflow-y-auto space-y-3 pr-1">
                {/* Rule-based insights */}
                {insights?.insights.map((ins, i) => (
                  <div key={i} className="p-3 rounded-xl bg-gray-50/80 border border-gray-100">
                    <div className="flex items-start gap-2 mb-1">
                      <InsightIcon type={ins.type} />
                      <span className="text-xs font-semibold text-gray-800 leading-snug">{ins.title}</span>
                      {importanceBadge(ins.importance)}
                    </div>
                    <p className="text-xs text-gray-500 leading-relaxed ml-6">{ins.description}</p>
                  </div>
                ))}

                {!insights?.insights.length && (
                  <div className="flex items-center justify-center h-full text-sm text-gray-400">
                    <div className="text-center space-y-2">
                      <Sparkles className="w-8 h-8 mx-auto text-gray-300" />
                      <p>No insights yet — add more receipts</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </ChartCard>
        </div>
      </div>

      {/* Categories + Suppliers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Spend by Category"
          subtitle={breakdown?.top_category ? `#1 ${breakdown.top_category.category} at ${breakdown.top_category.percentage}%` : undefined}
        >
          {loading.breakdown ? <Skeleton className="h-[280px]" /> : (categoryChart.labels.length > 0 ? (
            <div style={{ height: `${Math.max(categoryChart.labels.length * 36, 220)}px` }}><Bar data={categoryChart} options={barOpts} /></div>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No category data</div>
          ))}
        </ChartCard>

        <ChartCard
          title="Top Suppliers"
          subtitle={breakdown?.top_supplier ? `#1 ${breakdown.top_supplier.supplier} at KES ${formatKESCompact(breakdown.top_supplier.total)}` : undefined}
        >
          {loading.breakdown ? <Skeleton className="h-[280px]" /> : (supplierChart.labels.length > 0 ? (
            <div style={{ height: `${Math.max(supplierChart.labels.length * 36, 220)}px` }}><Bar data={supplierChart} options={barOpts} /></div>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No supplier data</div>
          ))}
        </ChartCard>
      </div>

      {/* Status + Tax + Batches */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Receipt Status */}
        <ChartCard title="Receipt Status">
          {loading.overview ? (
            <Skeleton className="h-[200px]" />
          ) : (
            <div className="flex items-center justify-center h-[200px]">
              <div className="w-[150px]">
                <Doughnut
                  data={statusChart}
                  options={{
                    responsive: true,
                    cutout: '65%',
                    plugins: {
                      legend: { position: 'bottom', labels: { padding: 20, usePointStyle: true, pointStyleWidth: 8, font: { size: 12 } } },
                      tooltip: { backgroundColor: '#1f2937', cornerRadius: 8, padding: 10 },
                    },
                  }}
                />
              </div>
            </div>
          )}
        </ChartCard>

        {/* Tax Summary */}
        <ChartCard title="Tax Breakdown">
          {loading.overview ? (
            <Skeleton className="h-[200px]" />
          ) : (
            <div className="h-[200px] flex flex-col justify-center space-y-5 px-2">
              <div>
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs text-gray-500">Subtotal (excl. VAT)</span>
                </div>
                <p className="text-lg font-bold text-gray-900">KES {formatKES(overview?.subtotal ?? 0)}</p>
                <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-blue-500" style={{ width: `${(overview?.subtotal ?? 0) + (overview?.tax_total ?? 0) > 0 ? ((overview?.subtotal ?? 0) / ((overview?.subtotal ?? 0) + (overview?.tax_total ?? 0))) * 100 : 0}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-baseline mb-1">
                  <span className="text-xs text-gray-500">VAT</span>
                  <span className="text-xs text-gray-400">{(overview?.subtotal ?? 0) > 0 ? `${(((overview?.tax_total ?? 0) / (overview?.subtotal ?? 1)) * 100).toFixed(1)}%` : '—'}</span>
                </div>
                <p className="text-lg font-bold text-gray-900">KES {formatKES(overview?.tax_total ?? 0)}</p>
                <div className="mt-2 w-full bg-gray-100 rounded-full h-1.5">
                  <div className="h-1.5 rounded-full bg-amber-500" style={{ width: `${(overview?.subtotal ?? 0) + (overview?.tax_total ?? 0) > 0 ? ((overview?.tax_total ?? 0) / ((overview?.subtotal ?? 0) + (overview?.tax_total ?? 0))) * 100 : 0}%` }} />
                </div>
              </div>
            </div>
          )}
        </ChartCard>

        {/* Quick Stats + Batches */}
        <ChartCard title="Overview">
          {loading.overview ? (
            <Skeleton className="h-[200px]" />
          ) : (
            <div className="h-[200px] flex flex-col justify-between">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-xl bg-gray-50">
                  <div className="flex items-center gap-1.5 mb-1">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-[10px] text-gray-500 uppercase font-medium">Processed</span>
                  </div>
                  <p className="text-lg font-bold text-gray-900">{overview?.processed_count ?? 0}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-gray-50">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Clock className="w-3.5 h-3.5 text-amber-500" />
                    <span className="text-[10px] text-gray-500 uppercase font-medium">To Review</span>
                  </div>
                  <p className="text-lg font-bold text-gray-900">{overview?.review_count ?? 0}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-gray-50">
                  <span className="text-[10px] text-gray-500 uppercase font-medium">Suppliers</span>
                  <p className="text-lg font-bold text-gray-900">{overview?.supplier_count ?? 0}</p>
                </div>
                <div className="p-2.5 rounded-xl bg-gray-50">
                  <span className="text-[10px] text-gray-500 uppercase font-medium">Categories</span>
                  <p className="text-lg font-bold text-gray-900">{overview?.category_count ?? 0}</p>
                </div>
              </div>

              {(overview?.batch_titles?.length ?? 0) > 0 && (
                <button
                  onClick={() => setBatchModal(true)}
                  className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors mt-2"
                >
                  <div className="flex items-center gap-2">
                    <Layers className="w-4 h-4 text-gray-400" />
                    <span className="text-xs font-medium text-gray-700">{overview?.batch_count} batch{(overview?.batch_count ?? 0) !== 1 ? 'es' : ''}</span>
                  </div>
                  <span className="text-xs text-indigo-600 font-medium">View</span>
                </button>
              )}
            </div>
          )}
        </ChartCard>
      </div>

      {/* Batch modal */}
      {batchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setBatchModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[70vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Receipt Batches</h3>
              <button onClick={() => setBatchModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <ul className="divide-y divide-gray-50 overflow-y-auto max-h-[55vh]">
              {(overview?.batch_titles ?? []).map((batch, i) => (
                <li key={i}>
                  <button
                    onClick={() => { navigate(`/receipts?batch=${encodeURIComponent(batch)}`); setBatchModal(false); }}
                    className="w-full text-left px-5 py-3.5 text-sm text-gray-700 hover:bg-gray-50 hover:text-indigo-600 transition-colors flex items-center gap-3"
                  >
                    <Layers className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    {batch}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};

export default DashboardPage;
