import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  ChevronDown,
  ChevronUp,
  FileJson,
  FileSpreadsheet,
  FileText,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../stores/toastStore';
import { reportsApi } from '../services/reportsApi';
import type { ReportDefInfo, ReportRunParams } from '../services/reportsApi';

const FORMAT_META: Record<string, { label: string; ext: string; icon: typeof FileText }> = {
  csv: { label: 'CSV', ext: 'csv', icon: FileText },
  xlsx: { label: 'XLSX', ext: 'xlsx', icon: FileSpreadsheet },
  pdf: { label: 'PDF', ext: 'pdf', icon: FileText },
  json: { label: 'JSON', ext: 'json', icon: FileJson },
};

const FILTER_LABELS: Record<string, string> = {
  status: 'Status',
  category: 'Category',
  supplier: 'Supplier',
  location: 'Location',
  batch_title: 'Batch title',
  kind: 'Kind',
  code: 'Error code',
  task_type: 'Task type',
  review_status: 'Review status',
  key: 'Setting key',
  is_active: 'Active (true/false)',
  is_admin: 'Is admin (true/false)',
  action: 'Action',
};

function ReportCard({ report, isAdmin }: { report: ReportDefInfo; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [includeSensitive, setIncludeSensitive] = useState(false);

  const hasSensitive = useMemo(() => report.columns.some((c) => c.sensitive), [report]);

  const run = async (format: string) => {
    setBusy(format);
    try {
      const params: ReportRunParams = {
        format,
        ...(report.dateFilter ? { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined } : {}),
        ...(hasSensitive && isAdmin && includeSensitive ? { includeSensitive: true } : {}),
        filters: Object.fromEntries(
          Object.entries(filterValues).filter(([, v]) => v.trim() !== '')
        ),
      };
      const filename = await reportsApi.download(report.key, params);
      toast.success(
        `${report.name} exported`,
        `Saved as ${filename}`,
        { duration: 5000 }
      );
    } catch (e) {
      toast.error(`${report.name} export failed`, e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="mt-0.5 p-2 rounded-lg bg-blue-50 text-blue-600 shrink-0">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center flex-wrap gap-2">
            <h3 className="font-semibold text-gray-900">{report.name}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {report.scope === 'admin' ? 'Admin only' : 'Your data'}
            </span>
            {hasSensitive && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full flex items-center gap-1 ${
                  includeSensitive ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                }`}
                title={isAdmin ? 'Sensitive staff columns excluded unless enabled' : 'Sensitive staff columns are never exported'}
              >
                {isAdmin && includeSensitive ? (
                  <Lock className="h-3 w-3" />
                ) : (
                  <ShieldCheck className="h-3 w-3" />
                )}
                {isAdmin && includeSensitive ? 'Sensitive included' : 'Sensitive excluded'}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 mt-1">{report.description}</p>
          <p className="text-xs text-gray-400 mt-1">
            {report.columns.length} columns{report.dateFilter ? ' · date filterable' : ''}
            {report.filters.length ? ` · filters: ${report.filters.join(', ')}` : ''}
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-gray-400 mt-1" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400 mt-1" />
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100">
          {report.dateFilter && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Calendar className="h-4 w-4 text-gray-400" />
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1"
                aria-label="From date"
              />
              <span className="text-sm text-gray-400">to</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="text-sm border border-gray-300 rounded-lg px-2 py-1"
                aria-label="To date"
              />
            </div>
          )}

          {report.filters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 mt-2">
              {report.filters.map((name) => (
                <input
                  key={name}
                  type="text"
                  placeholder={FILTER_LABELS[name] || name}
                  value={filterValues[name] || ''}
                  onChange={(e) => setFilterValues((prev) => ({ ...prev, [name]: e.target.value }))}
                  className="text-sm border border-gray-300 rounded-lg px-2 py-1 w-48"
                />
              ))}
            </div>
          )}

          {hasSensitive && isAdmin && (
            <label className="flex items-center gap-2 mt-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={includeSensitive}
                onChange={(e) => setIncludeSensitive(e.target.checked)}
                className="h-4 w-4"
              />
              Include sensitive staff columns (emails, names, user IDs)
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <span className="text-xs text-gray-400 mr-1">Download:</span>
            {(Object.keys(FORMAT_META) as Array<keyof typeof FORMAT_META>).map((fmt) => {
              const meta = FORMAT_META[fmt];
              const Icon = meta.icon;
              return (
                <button
                  key={fmt}
                  onClick={() => run(fmt)}
                  disabled={busy !== null}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition-colors disabled:opacity-50"
                >
                  {busy === fmt ? (
                    <span className="h-3 w-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Icon className="h-3.5 w-3.5" />
                  )}
                  {meta.label}
                </button>
              );
            })}
            <span className="text-xs text-gray-400 ml-1">
              {busy ? 'Generating…' : `${report.columns.length} columns`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = !!user?.is_admin;
  const [catalog, setCatalog] = useState<{ reports: ReportDefInfo[]; maxRows: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    reportsApi
      .list()
      .then((data) => {
        if (!cancelled) setCatalog(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-blue-600" />
          Reports & imports
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Every aspect of your data, exportable as CSV, XLSX, PDF or JSON.
          {isAdmin
            ? ' Admin reports cover the whole platform; sensitive staff columns are excluded from exports unless you enable them.'
            : ' Your reports only ever contain your own data; sensitive staff columns are never exported.'}
        </p>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm border border-red-200">
          {error}
        </div>
      )}

      {!catalog && !error && (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent" />
        </div>
      )}

      {catalog && (
        <>
          <div className="space-y-3">
            {catalog.reports.map((report) => (
              <ReportCard key={report.key} report={report} isAdmin={isAdmin} />
            ))}
          </div>
          <p className="text-xs text-gray-400 mt-4">
            Exports are capped at {catalog.maxRows.toLocaleString()} rows and every export is recorded in the audit trail.
          </p>
        </>
      )}
    </div>
  );
}