import { auth } from './firebase';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

async function getAuthHeader(): Promise<string> {
  if (auth?.currentUser) {
    const token = await auth.currentUser.getIdToken();
    if (token) return `Bearer ${token}`;
  }
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

function getUserId(): string {
  const userId = auth?.currentUser?.uid;
  if (!userId) throw new Error('User not authenticated');
  return userId;
}

async function apiRequest<T>(method: string, endpoint: string, data?: any): Promise<T> {
  const authorization = await getAuthHeader();
  const userId = getUserId();
  const url = `${API_BASE_URL}/users/${userId}${endpoint}`;

  const options: RequestInit = {
    method,
    headers: { 'Authorization': authorization, 'Content-Type': 'application/json' },
  };
  if (data) options.body = JSON.stringify(data);

  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = `API error: ${response.status}`;
    try { const err = await response.json(); detail = err.detail || detail; } catch {}
    throw new Error(detail);
  }
  if (response.status === 204) return undefined as any;
  return response.json();
}

export interface ReviewBatchItem {
  id: number;
  batch_id: string;
  receipt_id: string;
  review_status: 'pending_review' | 'in_review' | 'reviewed' | 'flagged';
  reviewer_notes: string | null;
  reviewed_at: string | null;
  receipt?: {
    id: string;
    supplier: string;
    totalAmount: string;
    taxAmount?: string;
    receiptDate: string;
    category?: string;
    invoiceNumber?: string;
    kraPin?: string;
    cuInvoice?: string;
    batchTitle?: string;
    status?: string;
    imageUrl?: string;
    items?: any[];
  } | null;
}

export interface ReviewBatch {
  id: string;
  user_id: string;
  name: string;
  csv_filename?: string;
  receipt_count: number;
  total_items: number;
  status_counts: Record<string, number>;
  created_at: string;
  updated_at: string;
  items?: ReviewBatchItem[];
}

export const reviewBatchApi = {
  /** Upload CSV and create a review batch */
  async upload(name: string, file: File): Promise<ReviewBatch> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const url = `${API_BASE_URL}/users/${userId}/review-batches/upload`;

    const formData = new FormData();
    formData.append('name', name);
    formData.append('file', file);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': authorization },
      body: formData,
    });

    if (!response.ok) {
      let detail = `Upload failed: ${response.status}`;
      try { const err = await response.json(); detail = err.detail || detail; } catch {}
      throw new Error(detail);
    }
    return response.json();
  },

  /** List all review batches */
  async list(): Promise<ReviewBatch[]> {
    return apiRequest('GET', '/review-batches');
  },

  /** Get a single batch with enriched receipt data */
  async get(batchId: string): Promise<ReviewBatch> {
    return apiRequest('GET', `/review-batches/${batchId}`);
  },

  /** Update review status of a single receipt in a batch */
  async updateStatus(
    batchId: string,
    receiptId: string,
    status: string,
    notes?: string,
  ): Promise<ReviewBatchItem> {
    const params = new URLSearchParams({ review_status: status });
    if (notes) params.append('notes', notes);
    return apiRequest('PUT', `/review-batches/${batchId}/items/${receiptId}/status?${params.toString()}`);
  },

  /** Delete a review batch */
  async delete(batchId: string): Promise<void> {
    return apiRequest('DELETE', `/review-batches/${batchId}`);
  },

  /** Remove a single receipt from a batch */
  async removeItem(batchId: string, receiptId: string): Promise<void> {
    return apiRequest('DELETE', `/review-batches/${batchId}/items/${receiptId}`);
  },

  /** Start background prefetch of all images in a batch */
  async prefetchImages(batchId: string): Promise<{ status: string; total_images: number }> {
    return apiRequest('POST', `/review-batches/${batchId}/prefetch`);
  },

  /** Export batch receipts using the existing export engine */
  async exportBatch(
    batchId: string,
    params: {
      format: 'xlsx' | 'pdf' | 'csv';
      reportType: string;
      date_from?: string;
      date_to?: string;
      pivotConfig?: { rowField: string; colField: string; valueField: string };
    },
  ): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const url = `${API_BASE_URL}/users/${userId}/review-batches/${batchId}/export`;

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
    const filename = match ? match[1] : `batch_export.${params.format}`;
    const url_blob = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url_blob;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url_blob);
  },
};
