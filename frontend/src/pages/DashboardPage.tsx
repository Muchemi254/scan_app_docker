import { useEffect, useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { dashboardApi, industriesApi } from '../services/api';
import {
  Chart as ChartJS,
  ArcElement, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
  PointElement, LineElement, Filler,
} from 'chart.js';
import { Doughnut, Bar, Line } from 'react-chartjs-2';
import {
  Wallet, Receipt, TrendingUp, Package,
  Calendar, ChevronDown, Layers, Settings2, X,
  Sparkles, AlertTriangle, Lightbulb, Zap, Target,
  CheckCircle2, Clock, Eye, EyeOff, Filter,
  Building2, PieChart as PieIcon,
} from 'lucide-react';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement, PointElement, LineElement, Filler);

type ChartType = 'bar' | 'line' | 'doughnut';

interface Overview {
  total_spent: number;
  total_receipts: number;
  total_items: number;
  avg_per_receipt: number;
  processed_count: number;
  pending_count: number;
  review_count: number;
  verified_count: number;
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
interface InsightsData { insights: { type: string; title: string; description: string; importance: string }[]; }

const CHART_COLORS = ['#6366f1','#8b5cf6','#a78bfa','#3b82f6','#60a5fa','#10b981','#34d399','#f59e0b','#fbbf24','#ef4444','#f87171','#ec4899','#f472b6','#06b6d4','#22d3ee'];
const STORAGE_KEY = 'scanapp-dashboard-prefs';

function fmtMMDDYYYY(d: Date): string { return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`; }
function formatKES(n:number){ return n.toLocaleString('en-KE',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function formatKESCompact(n:number){ if(n>=1_000_000) return `KES ${(n/1_000_000).toFixed(1)}M`; if(n>=1_000) return `KES ${(n/1_000).toFixed(1)}K`; return `KES ${n.toFixed(0)}`; }

function Skeleton({className}:{className?:string}){ return <div className={`animate-pulse bg-gray-100 rounded-xl ${className||''}`} />; }
function StatCard({title,value,subtitle,icon:Icon,color}:{title:string;value:string;subtitle?:string;icon:any;color:string}){
  return (
    <div className="relative overflow-hidden rounded-2xl bg-white border border-gray-100 p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5 min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{title}</p>
          <p className="text-2xl font-bold text-gray-900 tracking-tight truncate">{value}</p>
          {subtitle && <p className="text-xs text-gray-400">{subtitle}</p>}
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${color}`}><Icon className="w-5 h-5" /></div>
      </div>
    </div>
  );
}
function ChartCard({title,subtitle,children,className,onCustomize,customizable}:{title:string;subtitle?:string;children:any;className?:string;onCustomize?:()=>void;customizable?:boolean}){
  return (
    <div className={`rounded-2xl bg-white border border-gray-100 shadow-sm ${className||''}`}>
      <div className="px-5 pt-4 pb-1 flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {customizable && onCustomize && <button onClick={onCustomize} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Customize chart"><Settings2 className="w-4 h-4" /></button>}
      </div>
      <div className="px-3 pb-3">{children}</div>
    </div>
  );
}
function InsightIcon({type}:{type:string}){ const cls='w-4 h-4 flex-shrink-0 mt-0.5'; switch(type){case 'spending_pattern': return <Target className={`${cls} text-indigo-500`} />; case 'anomaly': return <AlertTriangle className={`${cls} text-amber-500`} />; case 'trend': return <Zap className={`${cls} text-emerald-500`} />; case 'tip': return <Lightbulb className={`${cls} text-blue-500`} />; default: return <Sparkles className={`${cls} text-gray-400`} />;}}
function importanceBadge(imp:string){ const map:any={high:'bg-red-50 text-red-700 border-red-200',medium:'bg-amber-50 text-amber-700 border-amber-200',low:'bg-gray-50 text-gray-600 border-gray-200'}; return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border uppercase tracking-wider ${map[imp]||map.low}`}>{imp}</span>; }

const DashboardPage = ({ userId }: { userId: string | null }) => {
  const navigate = useNavigate();
  const now = new Date();
  const currentYear = now.getFullYear();

  // persisted prefs
  const [prefs, setPrefs] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); } catch { return {}; }
  });
  const setPref = (k:string,v:any)=> setPrefs((p:any)=>{ const n={...p,[k]:v}; localStorage.setItem(STORAGE_KEY, JSON.stringify(n)); return n; });

  const [year, setYear] = useState<number | 'all'>(currentYear);
  const [years, setYears] = useState<number[]>([currentYear]);
  const [industryId, setIndustryId] = useState<string>('');
  const [industries, setIndustries] = useState<{id:string;name:string}[]>([]);
  const [includeUnreviewed, setIncludeUnreviewed] = useState<boolean>(()=> prefs.includeUnreviewed ?? false);
  const [chartPrefs, setChartPrefs] = useState<any>(()=> prefs.charts || { trend:'line', category:'bar', supplier:'bar', status:'doughnut', visible:{trend:true,category:true,supplier:true,status:true,yearly:true,insights:true} });

  const [overview, setOverview] = useState<Overview|null>(null);
  const [trends, setTrends] = useState<Trends|null>(null);
  const [breakdown, setBreakdown] = useState<Breakdown|null>(null);
  const [insights, setInsights] = useState<InsightsData|null>(null);
  const [yearly, setYearly] = useState<{ yearly: { year:string; label:string; total:number; count:number; avg_per_receipt:number }[]; period_total:number }|null>(null);
  const [loading, setLoading] = useState({overview:false,trends:false,breakdown:false,insights:false,yearly:false});
  const [batchModal, setBatchModal] = useState(false);

  // fetch years + industries
  useEffect(()=>{
    industriesApi.list().then(r=> setIndustries(r.items)).catch(()=>{});
    dashboardApi.years().then(r=>{
      const ys = r.years.length?r.years:[currentYear];
      setYears(ys);
      // if current year has no data, default to most recent year with data
      if (!ys.includes(currentYear as number) && year === currentYear) setYear(ys[0] as any);
    }).catch(()=>{});
  },[]);
  useEffect(()=>{ setPref('includeUnreviewed', includeUnreviewed); },[includeUnreviewed]);
  useEffect(()=>{ setPref('charts', chartPrefs); },[chartPrefs]);

  const dateFilters = useMemo(()=>{
    if (year==='all') return {date_from:undefined, date_to:undefined};
    return {date_from: fmtMMDDYYYY(new Date(year as number,0,1)), date_to: fmtMMDDYYYY(new Date(year as number,11,31))};
  },[year]);

  const fetchAll = useCallback(async()=>{
    if(!userId) return;
    const {date_from,date_to}=dateFilters;
    setLoading(l=>({...l, overview:true,trends:true,breakdown:true,insights:true}));
    const settle = <T,>(p:Promise<T>,on:(v:T)=>void,key:keyof typeof loading)=> p.then(v=>{on(v);return v;}).finally(()=> setLoading(l=>({...l,[key]:false})));
    await Promise.all([
      settle(dashboardApi.overview(date_from,date_to, industryId||undefined, includeUnreviewed), setOverview as any, 'overview'),
      settle(dashboardApi.trends(12,date_from,date_to, industryId||undefined, includeUnreviewed), setTrends as any, 'trends'),
      settle(dashboardApi.breakdown(date_from,date_to, industryId||undefined, includeUnreviewed), setBreakdown as any, 'breakdown'),
      settle(dashboardApi.insights(date_from,date_to, industryId||undefined, includeUnreviewed), setInsights as any, 'insights'),
    ]);
  },[userId,dateFilters,industryId,includeUnreviewed]);
  const fetchYearly = useCallback(async()=>{
    if(!userId) return;
    setLoading(l=>({...l, yearly:true}));
    try {
      const y = await dashboardApi.yearly(industryId||undefined, includeUnreviewed);
      setYearly(y);
    } catch { /* keep previous */ }
    finally { setLoading(l=>({...l, yearly:false})); }
  },[userId,industryId,includeUnreviewed]);
  useEffect(()=>{ fetchAll(); },[fetchAll]);
  useEffect(()=>{ fetchYearly(); },[fetchYearly]);

  const trendChart = useMemo(()=>({
    labels: trends?.monthly.map(t=>t.month_label)??[],
    datasets:[{label:'Spending',data:trends?.monthly.map(t=>t.total)??[], borderColor:'#6366f1', backgroundColor:'rgba(99,102,241,0.06)', fill:true, tension:0.4, pointRadius:3, pointBackgroundColor:'#6366f1', pointBorderColor:'#fff', pointBorderWidth:2, borderWidth:2}]
  }),[trends]);
  const categoryChart = useMemo(()=>({
    labels: (breakdown?.categories??[]).slice(0,5).map(c=>c.category),
    datasets:[{label:'KES',data:(breakdown?.categories??[]).slice(0,5).map(c=>c.total), backgroundColor:(breakdown?.categories??[]).slice(0,5).map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]), borderRadius:6, borderSkipped:false}]
  }),[breakdown]);
  const supplierChart = useMemo(()=>({
    labels: (breakdown?.suppliers??[]).slice(0,5).map(s=>s.supplier),
    datasets:[{label:'KES',data:(breakdown?.suppliers??[]).slice(0,5).map(s=>s.total), backgroundColor:(breakdown?.suppliers??[]).slice(0,5).map((_,i)=>CHART_COLORS[(i+3)%CHART_COLORS.length]), borderRadius:6, borderSkipped:false}]
  }),[breakdown]);
  const statusChart = useMemo(()=>({
    labels: ['Processed','Pending Approval','Needs Review'],
    datasets:[{data:[overview?.processed_count??0, overview?.pending_count??0, overview?.review_count??0], backgroundColor:['#10b981','#3b82f6','#f59e0b'], borderColor:'#fff', borderWidth:3}]
  }),[overview]);
  const yearlyComparison = useMemo(()=>{
    if(!yearly?.yearly?.length) return {labels:[], datasets:[]};
    const labels = yearly.yearly.map(y=> y.label);
    const data = yearly.yearly.map(y=> y.total);
    return {labels, datasets:[{label:'Yearly Total', data, backgroundColor:labels.map((_,i)=>CHART_COLORS[i%CHART_COLORS.length]), borderRadius:6}]};
  },[yearly]);

  const barOpts:any={indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1f2937',cornerRadius:8,padding:10,callbacks:{label:(c:any)=>` KES ${Number(c.raw).toLocaleString()}`}}},scales:{x:{grid:{color:'#f3f4f6'},ticks:{font:{size:11},callback:(v:any)=>Number(v).toLocaleString('en-KE',{notation:'compact',maximumFractionDigits:1})}},y:{grid:{display:false},ticks:{font:{size:12},autoSkip:false}}}};
  const lineOpts:any={responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#1f2937',cornerRadius:8,padding:10,callbacks:{label:(c:any)=>` KES ${Number(c.raw).toLocaleString()}`}}},scales:{x:{grid:{color:'#f9fafb'},ticks:{font:{size:11},maxRotation:45}},y:{grid:{color:'#f3f4f6'},ticks:{font:{size:11},callback:(v:any)=>Number(v).toLocaleString('en-KE',{notation:'compact',maximumFractionDigits:1})}}}};

  const visible = chartPrefs.visible||{trend:true,category:true,supplier:true,status:true,yearly:true,insights:true};

  return (
    <div className="p-4 sm:p-6 lg:p-8 w-full max-w-[1440px] mx-auto space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">{overview ? `${overview.verified_count} verified • ${overview.review_count} to review • ${overview.total_receipts} total` : 'Loading...'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Building2 className="absolute left-2.5 w-4 h-4 text-gray-400 top-1/2 -translate-y-1/2" />
            <select value={industryId} onChange={e=>setIndustryId(e.target.value)} className="pl-8 pr-8 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700">
              <option value="">All Industries</option>
              {industries.map(i=> <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </div>
          <div className="relative">
            <Calendar className="absolute left-3 w-4 h-4 text-gray-400 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select value={String(year)} onChange={e=> setYear(e.target.value==='all' ? 'all' : Number(e.target.value))} className="pl-9 pr-8 py-2.5 rounded-xl border border-gray-200 bg-white text-sm font-medium text-gray-700">
              <option value="all">All Time</option>
              {years.map(y=> <option key={y} value={String(y)}>{y}</option>)}
            </select>
            <ChevronDown className="absolute right-2.5 w-4 h-4 text-gray-400 pointer-events-none top-1/2 -translate-y-1/2" />
          </div>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm cursor-pointer hover:bg-gray-50">
            <input type="checkbox" checked={includeUnreviewed} onChange={e=>setIncludeUnreviewed(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-indigo-600" />
            <span className="text-gray-700 font-medium flex items-center gap-1">{includeUnreviewed ? <Eye className="w-3.5 h-3.5"/> : <EyeOff className="w-3.5 h-3.5"/>} Include unreviewed</span>
          </label>
          <button onClick={()=> setChartPrefs((p:any)=> ({...p, visible:{trend:true,category:true,supplier:true,status:true,yearly:true,insights:true}}))} className="p-2.5 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-gray-500" title="Reset customization"><Settings2 className="w-4 h-4" /></button>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {loading.overview && !overview ? [...Array(4)].map((_,i)=><Skeleton key={i} className="h-[104px]" />) : (
          <>
            <StatCard title="Verified Spent" value={formatKESCompact(overview?.total_spent??0)} subtitle={`${overview?.verified_count} verified`} icon={Wallet} color="bg-indigo-500/10 text-indigo-600" />
            <StatCard title="Receipts" value={String(overview?.verified_count??0)} subtitle={`${overview?.review_count??0} to review`} icon={Receipt} color="bg-emerald-500/10 text-emerald-600" />
            <StatCard title="Avg / Receipt" value={`KES ${formatKES(overview?.avg_per_receipt??0)}`} subtitle={overview?.largest_receipt ? `Largest ${formatKESCompact(overview.largest_receipt)}` : undefined} icon={TrendingUp} color="bg-blue-500/10 text-blue-600" />
            <StatCard title="Total Items" value={String(overview?.total_items??0)} subtitle={`${overview?.avg_items_per_receipt} per receipt`} icon={Package} color="bg-amber-500/10 text-amber-600" />
          </>
        )}
      </div>

      {/* Trend + Insights */}
      {visible.trend && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <ChartCard title="Monthly Spending" subtitle={trends?.best_month ? `Best: ${trends.best_month.month_label} (${formatKESCompact(trends.best_month.total)})` : undefined} customizable onCustomize={()=> setChartPrefs((p:any)=>({...p, trend: p.trend==='line'?'bar':'line'}))}>
            {loading.trends ? <Skeleton className="h-[280px]" /> : (trendChart.labels.length>0 ? <div className="h-[280px]">{chartPrefs.trend==='bar' ? <Bar data={trendChart} options={barOpts} /> : <Line data={trendChart} options={lineOpts} />}</div> : <div className="h-[280px] flex items-center justify-center text-sm text-gray-400">No trend data for {year}</div>)}
          </ChartCard>
        </div>
        <div className="lg:col-span-1">
          <ChartCard title="Insights">
            {loading.insights ? <Skeleton className="h-[280px]" /> : (
              <div className="h-[280px] overflow-y-auto space-y-3 pr-1">
                {insights?.insights.map((ins,i)=>(
                  <div key={i} className="p-3 rounded-xl bg-gray-50/80 border border-gray-100">
                    <div className="flex items-start gap-2 mb-1"><InsightIcon type={ins.type} /><span className="text-xs font-semibold text-gray-800 leading-snug">{ins.title}</span>{importanceBadge(ins.importance)}</div>
                    <p className="text-xs text-gray-500 leading-relaxed ml-6">{ins.description}</p>
                  </div>
                ))}
                {!insights?.insights.length && <div className="flex items-center justify-center h-full text-sm text-gray-400"><div className="text-center space-y-2"><Sparkles className="w-8 h-8 mx-auto text-gray-300" /><p>No insights yet — add more receipts</p></div></div>}
              </div>
            )}
          </ChartCard>
        </div>
      </div>
      )}

      {/* Categories + Suppliers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {visible.category && (
        <ChartCard title="Spend by Category" subtitle={breakdown?.top_category ? `#1 ${breakdown.top_category.category} at ${breakdown.top_category.percentage}%` : undefined} customizable onCustomize={()=> setChartPrefs((p:any)=>({...p, category: p.category==='bar'?'doughnut':'bar'}))}>
          {loading.breakdown ? <Skeleton className="h-[280px]" /> : (categoryChart.labels.length>0 ? (
            <div style={{height:`${Math.max(categoryChart.labels.length*36,220)}px`}}>
              {chartPrefs.category==='doughnut' ? <Doughnut data={categoryChart} options={{responsive:true,cutout:'60%',plugins:{legend:{position:'bottom',labels:{padding:16,usePointStyle:true}}}}} /> : <Bar data={categoryChart} options={barOpts} />}
            </div>
          ) : <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No category data</div>)}
        </ChartCard>
        )}
        {visible.supplier && (
        <ChartCard title="Top Suppliers" subtitle={breakdown?.top_supplier ? `#1 ${breakdown.top_supplier.supplier} at ${formatKESCompact(breakdown.top_supplier.total)}` : undefined} customizable onCustomize={()=> setChartPrefs((p:any)=>({...p, supplier: p.supplier==='bar'?'doughnut':'bar'}))}>
          {loading.breakdown ? <Skeleton className="h-[280px]" /> : (supplierChart.labels.length>0 ? (
            <div style={{height:`${Math.max(supplierChart.labels.length*36,220)}px`}}>
              {chartPrefs.supplier==='doughnut' ? <Doughnut data={supplierChart} options={{responsive:true,cutout:'60%',plugins:{legend:{position:'bottom',labels:{padding:16,usePointStyle:true}}}}} /> : <Bar data={supplierChart} options={barOpts} />}
            </div>
          ) : <div className="h-[220px] flex items-center justify-center text-sm text-gray-400">No supplier data</div>)}
        </ChartCard>
        )}
      </div>

      {/* Status + Yearly + Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {visible.status && (()=>{ const statusOpts:any={responsive:true,cutout:'65%',plugins:{legend:{position:'bottom',labels:{padding:14,usePointStyle:true,pointStyleWidth:8,font:{size:11}}},tooltip:{backgroundColor:'#1f2937',cornerRadius:8,padding:10}}}; return (
        <ChartCard title="Receipt Status" subtitle={includeUnreviewed ? 'Verified + To Review' : 'Verified only'}>
          {loading.overview ? <Skeleton className="h-[200px]" /> : (
            <div className="flex items-center justify-center h-[200px]">
              <div className="w-[160px]"><Doughnut data={statusChart} options={statusOpts} /></div>
            </div>
          )}
          <div className="px-2 pb-2 flex justify-center gap-2 text-[11px]">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Processed {overview?.processed_count}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Pending {overview?.pending_count}</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500" /> Review {overview?.review_count}</span>
          </div>
        </ChartCard>
        )})()}
        {visible.yearly && (
        <ChartCard title="Yearly Breakdown" subtitle="Last 5 years">
          {loading.yearly ? <Skeleton className="h-[200px]" /> : (yearlyComparison.labels.length>0 ? <div className="h-[200px]"><Bar data={yearlyComparison} options={{...barOpts, indexAxis:'x' as const}} /></div> : <div className="h-[200px] flex items-center justify-center text-sm text-gray-400">No yearly data</div>)}
        </ChartCard>
        )}
        <ChartCard title="Overview">
          {loading.overview ? <Skeleton className="h-[200px]" /> : (
            <div className="h-[200px] flex flex-col justify-between">
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2.5 rounded-xl bg-gray-50"><div className="flex items-center gap-1.5 mb-1"><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /><span className="text-[10px] text-gray-500 uppercase font-medium">Verified</span></div><p className="text-lg font-bold text-gray-900">{overview?.verified_count??0}</p><p className="text-xs text-gray-400">Processed + Pending</p></div>
                <div className="p-2.5 rounded-xl bg-gray-50"><div className="flex items-center gap-1.5 mb-1"><Clock className="w-3.5 h-3.5 text-amber-500" /><span className="text-[10px] text-gray-500 uppercase font-medium">To Review</span></div><p className="text-lg font-bold text-gray-900">{overview?.review_count??0}</p><p className="text-xs text-gray-400">Needs review</p></div>
                <div className="p-2.5 rounded-xl bg-gray-50"><span className="text-[10px] text-gray-500 uppercase font-medium">Suppliers</span><p className="text-lg font-bold text-gray-900">{overview?.supplier_count??0}</p></div>
                <div className="p-2.5 rounded-xl bg-gray-50"><span className="text-[10px] text-gray-500 uppercase font-medium">Categories</span><p className="text-lg font-bold text-gray-900">{overview?.category_count??0}</p></div>
              </div>
              {(overview?.batch_titles?.length??0)>0 && <button onClick={()=> setBatchModal(true)} className="flex items-center justify-between w-full px-3 py-2.5 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors mt-2"><div className="flex items-center gap-2"><Layers className="w-4 h-4 text-gray-400" /><span className="text-xs font-medium text-gray-700">{overview?.batch_count} batches</span></div><span className="text-xs text-indigo-600 font-medium">View</span></button>}
            </div>
          )}
        </ChartCard>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <Filter className="w-3.5 h-3.5" /> Filters:
        <span className="px-2 py-1 rounded-full bg-white border">{year==='all' ? 'All Time' : year}</span>
        <span className="px-2 py-1 rounded-full bg-white border">{industryId ? industries.find(i=>i.id===industryId)?.name : 'All Industries'}</span>
        <span className="px-2 py-1 rounded-full bg-white border">{includeUnreviewed ? 'Including unreviewed' : 'Verified only'}</span>
        <button onClick={()=> {setYear(currentYear); setIndustryId(''); setIncludeUnreviewed(false);}} className="px-2 py-1 rounded-full bg-gray-900 text-white hover:bg-black">Reset</button>
        <label className="ml-auto flex items-center gap-2 text-xs">
          <span>Hide:</span>
          {(['trend','category','supplier','status','yearly','insights'] as const).map(k=>(
            <label key={k} className="flex items-center gap-1 cursor-pointer"><input type="checkbox" checked={!!visible[k]} onChange={e=> setChartPrefs((p:any)=>({...p, visible:{...p.visible,[k]:e.target.checked}}))} className="h-3 w-3" />{k}</label>
          ))}
        </label>
      </div>

      {batchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={()=> setBatchModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[70vh] overflow-hidden" onClick={e=> e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h3 className="text-lg font-semibold text-gray-900">Receipt Batches</h3>
              <button onClick={()=> setBatchModal(false)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <ul className="divide-y divide-gray-50 overflow-y-auto max-h-[55vh]">
              {(overview?.batch_titles ?? []).map((batch,i)=>(
                <li key={i}><button onClick={()=>{ navigate(`/receipts?batch=${encodeURIComponent(batch)}`); setBatchModal(false); }} className="w-full text-left px-5 py-3.5 text-sm text-gray-700 hover:bg-gray-50 hover:text-indigo-600 flex items-center gap-3"><Layers className="w-4 h-4 text-gray-400 flex-shrink-0" />{batch}</button></li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
export default DashboardPage;
