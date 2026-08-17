import { getAuthHeader } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export interface ReportColumnDef {
  key: string;
  label: string;
  sensitive: boolean;
}

export interface ReportDefInfo {
  key: string;
  name: string;
  description: string;
  scope: 'owner' | 'admin';
  columns: ReportColumnDef[];
  filters: string[];
  dateFilter: boolean;
}

export interface ReportCatalog {
  reports: ReportDefInfo[];
  formats: string[];
  maxRows: number;
}

export interface ReportRunParams {
  format: string;
  dateFrom?: string;
  dateTo?: string;
  includeSensitive?: boolean;
  filters?: Record<string, string>;
}

export const reportsApi = {
  async list(): Promise<ReportCatalog> {
    const resp = await fetch(`${API_BASE_URL}/reports`, {
      headers: { Authorization: getAuthHeader() },
    });
    if (!resp.ok) {
      throw new Error(`Failed to load reports catalog (${resp.status})`);
    }
    return resp.json();
  },

  async download(reportKey: string, params: ReportRunParams): Promise<string> {
    const resp = await fetch(
      `${API_BASE_URL}/reports/${encodeURIComponent(reportKey)}/export`,
      {
        method: 'POST',
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      }
    );
    if (!resp.ok) {
      let detail = `Export failed (${resp.status})`;
      try {
        const data = await resp.json();
        if (data?.detail) detail = data.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    const blob = await resp.blob();
    const disposition = resp.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `report_${reportKey}.${params.format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return filename;
  },
};