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

import { auth } from './firebase';

// Use a relative path so the app works on any device/IP on the network.
// Nginx proxies /api/* → backend container. Absolute URL only applies
// when VITE_API_URL is explicitly overridden (e.g. for direct local dev
// without Docker, pointing to http://localhost:8000/api/v1).
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

/**
 * Get authorization header with Firebase token.
 * Waits up to 5 s for Firebase to restore a persisted session before giving up.
 * This prevents a race condition on first load where auth.currentUser is briefly
 * null while Firebase hydrates from IndexedDB.
 */
async function getAuthHeader(): Promise<string> {
  // Fast path — token already available
  if (auth?.currentUser) {
    const token = await auth.currentUser.getIdToken();
    if (token) return `Bearer ${token}`;
  }

  // Slow path — wait for Firebase to restore the session (up to 5 s)
  const token = await new Promise<string | null>(resolve => {
    if (!auth) { resolve(null); return; }
    const unsubscribe = auth.onAuthStateChanged(user => {
      unsubscribe();
      if (user) {
        user.getIdToken().then(t => resolve(t)).catch(() => resolve(null));
      } else {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });

  if (!token) throw new Error('Authentication failed');
  return `Bearer ${token}`;
}

/**
 * Get current user ID (sync — only call after auth is confirmed).
 */
function getUserId(): string {
  const userId = auth?.currentUser?.uid;
  if (!userId) throw new Error('User not authenticated');
  return userId;
}

/**
 * Generic API request handler
 */
async function apiRequest<T>(
  method: string,
  endpoint: string,
  data?: any
): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = getUserId();
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
 * File upload handler (multipart/form-data)
 */
async function apiUpload<T>(
  method: string,
  endpoint: string,
  file?: File,
  data?: any
): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = getUserId();
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
    const userId = getUserId();
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
  async get(receiptId: string): Promise<any> {
    return apiRequest('GET', `/receipts/${receiptId}`);
  },

  /**
   * Update receipt (partial update)
   * Optionally upload new image
   */
  async update(receiptId: string, updates: any, file?: File): Promise<any> {
    return apiUpload('PUT', `/receipts/${receiptId}`, file, updates);
  },

  /**
   * Delete receipt
   */
  async delete(receiptId: string): Promise<void> {
    return apiRequest('DELETE', `/receipts/${receiptId}`);
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
  async getAuditTrail(receiptId: string): Promise<{ items: any[]; total: number }> {
    return apiRequest('GET', `/receipts/${receiptId}/audit`);
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
    const userId = getUserId();
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
    reportType: 'detailed' | 'category' | 'supplier' | 'monthly' | 'tax' | 'pivot';
    date_from?: string;
    date_to?: string;
    category?: string;
    pivotConfig?: { rowField: string; colField: string; valueField: string };
  }): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
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
