/**
 * API Service - REST Client for Backend Communication
 *
 * Replaces direct Firebase calls with REST API calls to FastAPI backend.
 * This is the single source of truth for all backend communication.
 *
 * Usage:
 *   const extracted = await receiptApi.extract(imageFile);
 *   const receipt = await receiptApi.create(data);
 *   const list = await receiptApi.list();
 */

import { getAuthHeader as getToken, getUserId } from './auth';
import { useScopeStore } from '../stores/scopeStore';

// Use a relative path so the app works on any device/IP on the network.
// Nginx proxies /api/* → backend container. Absolute URL only applies
// when VITE_API_URL is explicitly overridden (e.g. for direct local dev
// without Docker, pointing to http://localhost:8000/api/v1).
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

/**
 * Get authorization header with the local access token.
 * Sync — the token is read straight from localStorage.
 */
function getAuthHeader(): string {
  return getToken();
}

/**
 * The user whose workspace every request should target.
 * Normal users target their own uid; an admin who selected a user scope
 * (see Layout scope selector) targets that user instead.
 */
function getScopeUid(): string {
  return useScopeStore.getState().activeUid || getUserId();
}

/**
 * Generic API request handler
 */
async function apiRequest<T>(
  method: string,
  endpoint: string,
  data?: any,
  ownerUid?: string
): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = ownerUid || getScopeUid();
  const url = `${API_BASE_URL}/users/${userId}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json',
    },
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    let detail = `API error: ${response.status}`;
    try {
      const error = await response.json();
      detail = error.detail || detail;
    } catch {}
    throw new Error(detail);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as any;
  }

  return response.json();
}

/**
 * Generic API request handler for endpoints that are NOT user-scoped
 * (e.g. /admin/..., /locations, /settings/global/...). The caller supplies
 * the full endpoint path after /api/v1.
 */
async function apiGlobalRequest<T>(
  method: string,
  endpoint: string,
  data?: any
): Promise<T> {
  const authorization = await getAuthHeader();
  const url = `${API_BASE_URL}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json',
    },
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);

  if (!response.ok) {
    let detail = `API error: ${response.status}`;
    try {
      const error = await response.json();
      detail = error.detail || detail;
    } catch {}
    throw new Error(detail);
  }

  if (response.status === 204) {
    return undefined as any;
  }

  return response.json();
}

/**
 * File upload handler (multipart/form-data)
 */
async function apiUpload<T>(
  method: string,
  endpoint: string,
  file?: File,
  data?: any,
  ownerUid?: string
): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = ownerUid || getScopeUid();
  const url = `${API_BASE_URL}/users/${userId}${endpoint}`;

  const formData = new FormData();

  // Add file if provided
  if (file) {
    formData.append('file', file);
  }

  // Serialize all data fields as a single JSON string so nested objects
  // (e.g. items array) survive the multipart round-trip without Pydantic
  // trying to parse each form field individually.
  if (data) {
    formData.append('receipt_data', JSON.stringify(data));
  }

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': authorization,
    },
    body: formData,
  });

  if (!response.ok) {
    let detail = `API error: ${response.status}`;
    try {
      const error = await response.json();
      detail = error.detail || detail;
    } catch {}
    throw new Error(detail);
  }

  if (response.status === 204) {
    return undefined as any;
  }

  return response.json();
}

// ============================================================================
// Receipt API - Main API Interface
// ============================================================================

export const receiptApi = {
  /**
   * Extract receipt data from image using Gemini AI
   * Returns extracted data without saving
   */
  async extract(file: File): Promise<any> {
    return apiUpload('POST', '/receipts/extract', file);
  },

  /**
   * Asynchronous batch extraction
   */
  async batchExtract(files: File[]): Promise<{ task_id: string }> {
    const authorization = await getAuthHeader();
    const userId = getScopeUid();
    const url = `${API_BASE_URL}/users/${userId}/receipts/batch-extract`;

    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
      },
      body: formData,
    });

    if (!response.ok) {
      let detail = `API error: ${response.status}`;
      try {
        const error = await response.json();
        detail = error.detail || detail;
      } catch {}
      throw new Error(detail);
    }

    return response.json();
  },

  /**
   * Create new receipt
   * Optionally upload image in same request
   */
  async create(receipt: any, file?: File): Promise<any> {
    return apiUpload('POST', '/receipts', file, receipt);
  },

  /**
   * List receipts with pagination and filters
   */
  async list(skip = 0, limit = 50, filters?: any): Promise<any> {
    const params = new URLSearchParams({
      skip: skip.toString(),
      limit: limit.toString(),
    });

    if (filters?.status) params.append('status', filters.status);
    if (filters?.category) params.append('category', filters.category);
    if (filters?.batchTitle) params.append('batchTitle', filters.batchTitle);

    return apiRequest('GET', `/receipts?${params.toString()}`);
  },

  /**
   * Get receipt groups for gallery browsing.
   * Returns receipts grouped by batchTitle with counts and thumbnails.
   */
  async getGroups(): Promise<{
    groups: {
      batchTitle: string;
      count: number;
      thumbnailUrl: string | null;
      totalAmount: number;
      latestDate: string | null;
      firstSupplier: string | null;
    }[];
  }> {
    return apiRequest('GET', '/receipts/groups');
  },

  /** Full-text search across receipts + items */
  async search(q: string, limit = 50, offset = 0): Promise<{ total: number; results: any[] }> {
    const p = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    return apiRequest('GET', `/receipts/search?${p.toString()}`);
  },

  /**
   * Get single receipt by ID
   */
  async get(receiptId: string, ownerUid?: string): Promise<any> {
    return apiRequest('GET', `/receipts/${receiptId}`, undefined, ownerUid);
  },

  /**
   * Update receipt (partial update)
   * Optionally upload new image
   */
  async update(receiptId: string, updates: any, file?: File, ownerUid?: string): Promise<any> {
    return apiUpload('PUT', `/receipts/${receiptId}`, file, updates, ownerUid);
  },

  /**
   * Delete receipt
   */
  async delete(receiptId: string, ownerUid?: string): Promise<void> {
    return apiRequest('DELETE', `/receipts/${receiptId}`, undefined, ownerUid);
  },

  /**

  /**
   * Check for duplicate receipts before creating/updating
   */
  async checkDuplicate(data: {
    supplier?: string;
    totalAmount?: string;
    receiptDate?: string;
    invoiceNumber?: string;
    excludeId?: string;
  }): Promise<{ is_duplicate: boolean; matches: any[] }> {
    return apiRequest('POST', '/receipts/check-duplicate', data);
  },

  /**
   * Get audit trail for a receipt
   */
  async getAuditTrail(receiptId: string, ownerUid?: string): Promise<{ items: any[]; total: number }> {
    return apiRequest('GET', `/receipts/${receiptId}/audit`, undefined, ownerUid);
  },

  // ── Review → approval workflow ──────────────────────────────────────────
  // ownerUid is explicit so admins acting on another user's receipt (global
  // Approvals page) work independently of the currently selected scope.

  /** needs_review → pending_approval (owner or admin). */
  async submitForApproval(ownerUid: string, receiptId: string): Promise<any> {
    return apiRequest('POST', `/receipts/${receiptId}/submit`, undefined, ownerUid);
  },

  /** pending_approval → needs_review (owner or admin). */
  async recall(ownerUid: string, receiptId: string): Promise<any> {
    return apiRequest('POST', `/receipts/${receiptId}/recall`, undefined, ownerUid);
  },

  /** pending_approval → processed (admin only). */
  async approve(ownerUid: string, receiptId: string): Promise<any> {
    return apiRequest('POST', `/receipts/${receiptId}/approve`, undefined, ownerUid);
  },

  /** pending_approval → needs_review (admin only), with optional note. */
  async reject(ownerUid: string, receiptId: string, note?: string): Promise<any> {
    return apiRequest('POST', `/receipts/${receiptId}/reject`, note ? { note } : undefined, ownerUid);
  },

  /** Cross-tenant list of every pending-approval receipt (admin only). */
  async listPendingApproval(): Promise<any[]> {
    const authorization = await getAuthHeader();
    const response = await fetch(`${API_BASE_URL}/admin/receipts/pending-approval`, {
      method: 'GET',
      headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      let detail = `API error: ${response.status}`;
      try { const error = await response.json(); detail = error.detail || detail; } catch {}
      throw new Error(detail);
    }
    return response.json();
  },

  /**
   * Generate spending summary with AI analysis
   */
  async generateSummary(filters?: {
    date_from?: string;
    date_to?: string;
    category?: string;
  }): Promise<{
    total_spent: number;
    total_receipts: number;
    total_items: number;
    avg_per_receipt: number;
    category_breakdown: { category: string; total: number; count: number; percentage: number }[];
    top_suppliers: { supplier: string; total: number; count: number }[];
    monthly_trend: { month: string; total: number; count: number }[];
    ai_summary: string | null;
  }> {
    return apiRequest('POST', '/receipts/summary', filters || {});
  },
};

// ============================================================================
// Task API - Progress Tracking
// ============================================================================

export const taskApi = {
  /**
   * Create a new task
   */
  async createTask(taskData: any): Promise<any> {
    return apiRequest('POST', '/tasks', taskData);
  },

  /**
   * Get task details
   */
  async getTask(taskId: string): Promise<any> {
    return apiRequest('GET', `/tasks/${taskId}`);
  },

  /**
   * List user's tasks
   */
  async listTasks(skip = 0, limit = 50, status?: string): Promise<any> {
    const params = new URLSearchParams({
      skip: skip.toString(),
      limit: limit.toString(),
    });

    if (status) params.append('status', status);

    return apiRequest('GET', `/tasks?${params.toString()}`);
  },

  /**
   * Get active tasks
   */
  async getActiveTasks(): Promise<any> {
    return apiRequest('GET', `/tasks/active`);
  },

  /**
   * Update task progress
   */
  async updateProgress(taskId: string, progress: any): Promise<any> {
    return apiRequest('PUT', `/tasks/${taskId}/progress`, progress);
  },

  /**
   * Pause task
   */
  async pauseTask(taskId: string): Promise<any> {
    return apiRequest('PUT', `/tasks/${taskId}/pause`);
  },

  /**
   * Resume task
   */
  async resumeTask(taskId: string): Promise<any> {
    return apiRequest('PUT', `/tasks/${taskId}/resume`);
  },

  /**
   * Delete task
   */
  async deleteTask(taskId: string): Promise<any> {
    return apiRequest('DELETE', `/tasks/${taskId}`);
  },
};

// ============================================================================
// Batch Scanning API
// ============================================================================

export const batchApi = {
  /** Create a batch record. Returns batchId immediately so it can be stored
   *  in localStorage before files are uploaded. */
  async create(batchTitle: string, filenames: string[]): Promise<{ batchId: string }> {
    return apiRequest('POST', '/batches', { batchTitle, filenames });
  },

  /** Upload all files and start backend processing. Returns immediately. */
  async process(
    batchId: string, 
    files: File[], 
    onProgress?: (percent: number) => void
  ): Promise<any> {
    const authorization = await getAuthHeader();
    const userId = getScopeUid();
    const url = `${API_BASE_URL}/users/${userId}/batches/${batchId}/process`;

    const form = new FormData();
    files.forEach(f => form.append('files', f));

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', authorization);

      if (onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            onProgress(percent);
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error(`Upload succeeded (${xhr.status}) but response was not valid JSON`));
          }
        } else {
          let detail = `Upload failed: ${xhr.status}`;
          try {
            const error = JSON.parse(xhr.responseText);
            detail = error.detail || detail;
          } catch {}
          reject(new Error(detail));
        }
      };

      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.send(form);
    });
  },

  /** Poll batch status. */
  async status(batchId: string): Promise<any> {
    return apiRequest('GET', `/batches/${batchId}`);
  },

  /** List all active batches for the current user. */
  async listActive(): Promise<any[]> {
    return apiRequest('GET', '/batches');
  },

  /** Dismiss a completed/failed batch. */
  async dismiss(batchId: string): Promise<void> {
    return apiRequest('DELETE', `/batches/${batchId}`);
  },

  /** Retry a single failed chunk inside a batch. */
  async retryChunk(batchId: string, chunkIndex: number): Promise<any> {
    return apiRequest('POST', `/batches/${batchId}/chunks/${chunkIndex}/retry`);
  },

  /** Retry a single failed item inside a batch (cost: 1 Gemini call). */
  async retryItem(batchId: string, itemIndex: number): Promise<any> {
    return apiRequest('POST', `/batches/${batchId}/items/${itemIndex}/retry`);
  },

  /** Send prepared (held) images to AI — per group, per item, or all.
   *  Only still-prepared items are sent; the same image is never sent twice. */
  async dispatch(
    batchId: string,
    opts: { groups?: number[]; items?: number[]; all?: boolean } = {}
  ): Promise<{ batchId: string; dispatched: number; status: string }> {
    return apiRequest('POST', `/batches/${batchId}/dispatch`, opts);
  },
};

// ============================================================================
// Scan Errors API — durable, reviewable failure log
// ============================================================================

export interface ScanError {
  id: string;
  kind: 'batch' | 'chunk' | 'item' | 'system';
  code: string;
  message: string;
  title: string | null;
  batch_id: string | null;
  item_index: number | null;
  receipt_id: string | null;
  data: any;
  read: boolean;
  created_at: number | null;
}

export const scanErrorApi = {
  /** List the user's recorded scan/batch errors, newest first. */
  async list(limit = 100): Promise<{ errors: ScanError[]; total: number }> {
    return apiRequest('GET', `/scan-errors?limit=${limit}`);
  },

  /** Unread error count for the header bell badge. */
  async unreadCount(): Promise<{ unread: number }> {
    return apiRequest('GET', '/scan-errors/unread-count');
  },

  /** Mark a single error as read. */
  async markRead(id: string): Promise<{ ok: boolean }> {
    return apiRequest('POST', `/scan-errors/${id}/read`);
  },

  /** Mark every error as read. Returns the number marked. */
  async markAllRead(): Promise<{ marked: number }> {
    return apiRequest('POST', '/scan-errors/read-all');
  },

  /** Dismiss a single error record. */
  async remove(id: string): Promise<void> {
    return apiRequest('DELETE', `/scan-errors/${id}`);
  },

  /** Clear the whole error log. */
  async clearAll(): Promise<void> {
    return apiRequest('DELETE', '/scan-errors');
  },
};

// ============================================================================
// Data Cleaning API
// ============================================================================

export const cleaningApi = {
  /**
   * Get cleaning suggestions: supplier merges, field propagation, duplicates.
   */
  async getSuggestions(): Promise<{
    supplier_merges: any[];
    field_propagations: any[];
    duplicates: any[];
    total_mismatches: any[];
  }> {
    return apiRequest('GET', '/receipts/clean/suggestions');
  },

  /**
   * Apply selected cleaning actions.
   */
  async applyActions(actions: any[]): Promise<{ status: string; stats: any }> {
    return apiRequest('POST', '/receipts/clean/apply', { actions });
  },

  /**
   * Dismiss a suggestion so it won't appear again.
   */
  async ignoreSuggestion(suggestion: any): Promise<{ status: string; ignored: boolean }> {
    return apiRequest('POST', '/receipts/clean/ignore', suggestion);
  },
};

// ============================================================================
// Settings API
// ============================================================================

export const settingsApi = {
  /**
   * Get user's AI settings
   */
  async getAISettings(): Promise<any> {
    return apiRequest('GET', '/settings/ai');
  },

  /**
   * Update user's AI settings
   */
  async updateAISettings(settings: any): Promise<any> {
    return apiRequest('PUT', '/settings/ai', settings);
  },

  /**
   * Test AI settings (API key)
   */
  async testAISettings(testRequest: any): Promise<{ success: boolean; message: string }> {
    return apiRequest('POST', '/settings/ai/test', testRequest);
  },

  /**
   * Get available AI models
   */
  async getAvailableModels(): Promise<any[]> {
    const authorization = await getAuthHeader();
    const url = `${API_BASE_URL}/settings/models`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.status}`);
    }

    return response.json();
  },

  /** Get the user's personal default tax rate (with the global fallback). */
  async getTaxPreference(): Promise<{ default_tax_rate: number; global_default: number }> {
    return apiRequest('GET', '/settings/tax');
  },

  /** Set the user's personal default tax rate (percent). */
  async setTaxPreference(default_tax_rate: number): Promise<{ default_tax_rate: number; global_default: number }> {
    return apiRequest('PUT', '/settings/tax', { default_tax_rate });
  },

  /** Get the admin-managed global default tax rate (percent). */
  async getGlobalTaxRate(): Promise<{ default_tax_rate: number }> {
    return apiGlobalRequest('GET', '/settings/global/tax-rate');
  },

  /** Set the admin-managed global default tax rate (percent). */
  async setGlobalTaxRate(default_tax_rate: number): Promise<{ default_tax_rate: number }> {
    return apiGlobalRequest('PUT', '/settings/global/tax-rate', { default_tax_rate });
  },

  /** Get the admin-managed per-user backup quota + retention. */
  async getBackupLimits(): Promise<{ max_backup_bytes_per_user: number; max_backups_per_user: number }> {
    return apiGlobalRequest('GET', '/settings/global/backup-limits');
  },

  /** Set the admin-managed per-user backup quota + retention. */
  async setBackupLimits(max_backup_bytes_per_user: number, max_backups_per_user: number): Promise<{ max_backup_bytes_per_user: number; max_backups_per_user: number }> {
    return apiGlobalRequest('PUT', '/settings/global/backup-limits', { max_backup_bytes_per_user, max_backups_per_user });
  },
};

// ============================================================================
// Locations API - admin-managed reference data for receipt locations
// ============================================================================

export const locationsApi = {
  /** List active locations (any authenticated user). */
  async list(): Promise<{ total: number; items: { id: string; name: string; is_active: boolean }[] }> {
    return apiGlobalRequest('GET', '/locations');
  },

  /** Create a location (admin only). */
  async create(name: string): Promise<{ id: string; name: string; is_active: boolean }> {
    return apiGlobalRequest('POST', '/locations', { name });
  },

  /** Update a location (admin only). */
  async update(id: string, body: { name?: string; is_active?: boolean }): Promise<{ id: string; name: string; is_active: boolean }> {
    return apiGlobalRequest('PUT', `/locations/${id}`, body);
  },

  /** Delete a location (admin only). */
  async remove(id: string): Promise<void> {
    return apiGlobalRequest('DELETE', `/locations/${id}`);
  },
};

// ============================================================================
// Export API - Server-side report generation
// ============================================================================

export const exportApi = {
  /**
   * Generate a report on the server and download the file.
   * Supports Excel (multi-sheet styled), PDF (professional layout), and CSV.
   */
  async downloadReport(params: {
    format: 'xlsx' | 'pdf' | 'csv';
    reportType: 'detailed' | 'category' | 'supplier' | 'monthly' | 'tax' | 'pivot' | 'receipts';
    date_from?: string;
    date_to?: string;
    category?: string;
    pivotConfig?: { rowField: string; colField: string; valueField: string };
    columns?: string[];
  }): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getScopeUid();
    const url = `${API_BASE_URL}/users/${userId}/receipts/export`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      let detail = `Export failed: ${response.status}`;
      try { const err = await response.json(); detail = err.detail || detail; } catch {}
      throw new Error(detail);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?(.+?)"?$/);
    const filename = match ? match[1] : `export.${params.format}`;
    const url_blob = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url_blob;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url_blob);
  },
};

// ============================================================================
// Dashboard API - Purpose-built analytics endpoints
// ============================================================================

export const dashboardApi = {
  /** KPI-level overview: totals, counts, averages, tax breakdown */
  async overview(date_from?: string, date_to?: string): Promise<{
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
    date_range_start: string | null;
    date_range_end: string | null;
  }> {
    const params = new URLSearchParams();
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);
    const qs = params.toString();
    return apiRequest('GET', `/dashboard/overview${qs ? `?${qs}` : ''}`);
  },

  /** Monthly spending time-series */
  async trends(months?: number, date_from?: string, date_to?: string): Promise<{
    monthly: { month: string; month_label: string; total: number; count: number; avg_per_receipt: number }[];
    period_total: number;
    period_avg_monthly: number;
    best_month: { month: string; month_label: string; total: number; count: number; avg_per_receipt: number } | null;
    worst_month: { month: string; month_label: string; total: number; count: number; avg_per_receipt: number } | null;
    month_over_month_change: number | null;
  }> {
    const params = new URLSearchParams();
    if (months) params.append('months', String(months));
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);
    return apiRequest('GET', `/dashboard/trends?${params.toString()}`);
  },

  /** Category + supplier breakdown */
  async breakdown(date_from?: string, date_to?: string): Promise<{
    categories: { category: string; total: number; count: number; percentage: number; avg_per_receipt: number }[];
    suppliers: { supplier: string; total: number; count: number; percentage: number; avg_per_receipt: number }[];
    top_category: { category: string; total: number; count: number; percentage: number; avg_per_receipt: number } | null;
    top_supplier: { supplier: string; total: number; count: number; percentage: number; avg_per_receipt: number } | null;
  }> {
    const params = new URLSearchParams();
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);
    const qs = params.toString();
    return apiRequest('GET', `/dashboard/breakdown${qs ? `?${qs}` : ''}`);
  },

  /** Computed insights + optional AI summary */
  async insights(date_from?: string, date_to?: string): Promise<{
    insights: { type: string; title: string; description: string; importance: string }[];
    ai_summary: string | null;
  }> {
    const params = new URLSearchParams();
    if (date_from) params.append('date_from', date_from);
    if (date_to) params.append('date_to', date_to);
    const qs = params.toString();
    return apiRequest('GET', `/dashboard/insights${qs ? `?${qs}` : ''}`);
  },
};

export default receiptApi;
