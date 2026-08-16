import { getAuthHeader, getUserId } from './authUtils';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export interface BackupEntry {
  id: string;
  user_id: string;
  filename: string;
  created_at: string;
  size_bytes: number;
  size_kb: number;
  available: boolean;
  image_count?: number;
  missing_images?: number;
}

export interface BackupPreview {
  manifest: any;
  receipt_count: number;
  image_count: number;
  size_kb: number;
  external_conflict_count?: number;
  receipts: Array<{
    id: string;
    supplier: string;
    totalAmount: string;
    receiptDate: string;
    category: string;
    status: string;
    hasImage: boolean;
  }>;
}

export interface ImportResult {
  status: string;
  stats: {
    receipts: number;
    items: number;
    tasks: number;
    settings: number;
    images: number;
    skipped: number;
    errors: number;
    remapped?: number;
  };
}

/** Raised when a backup contains receipt IDs already owned by another account. */
export class ExternalConflictError extends Error {
  conflictCount: number;
  constructor(conflictCount: number, message: string) {
    super(message);
    this.name = 'ExternalConflictError';
    this.conflictCount = conflictCount;
  }
}

export interface BackupQuota {
  used_bytes: number;
  limit_bytes: number;
  count: number;
  max_count: number;
}

export const backupApi = {
  /** Create and download a backup with progress callback */
  async exportBackup(onProgress?: (pct: number, status: string) => void): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const url = `${API_BASE_URL}/users/${userId}/backup/export`;

    onProgress?.(5, 'Connecting...');
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authorization },
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Export failed');
    }

    const contentLength = response.headers.get('Content-Length');
    const total = contentLength ? parseInt(contentLength) : 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    onProgress?.(10, 'Downloading...');
    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        const pct = Math.round(10 + (received / total) * 80);
        onProgress?.(pct, `Downloading ${(received / 1024 / 1024).toFixed(1)} MB...`);
      }
    }

    onProgress?.(95, 'Finalizing...');
    const blob = new Blob(chunks);
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?(.+?)"?$/);
    const filename = match ? match[1] : 'scanapp_backup.tar.gz';
    const url_blob = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url_blob;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url_blob);
    onProgress?.(100, 'Complete');
  },

  /** List all backups */
  async listBackups(): Promise<BackupEntry[]> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/list`,
      { headers: { Authorization: authorization } }
    );
    if (!response.ok) throw new Error('Failed to list backups');
    return response.json();
  },

  /** Download a specific backup (cross-device: any device with the account's session can fetch it) */
  async downloadBackup(backupId: string, filename: string): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/download/${backupId}`,
      { headers: { Authorization: authorization } }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Download failed');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'scanapp_backup.tar.gz';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  /** Per-user backup quota usage (for the Settings UI space meter) */
  async getBackupQuota(): Promise<BackupQuota> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/quota`,
      { headers: { Authorization: authorization } }
    );
    if (!response.ok) throw new Error('Failed to load backup quota');
    return response.json();
  },

  /** Preview a backup file before import */
  async previewBackup(file: File): Promise<BackupPreview> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/preview`,
      {
        method: 'POST',
        headers: { Authorization: authorization },
        body: formData,
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Preview failed');
    }
    return response.json();
  },

  /** Import a backup */
  async importBackup(
    file: File,
    conflict: string,
    selectedIds?: string[],
    externalConflict?: string,
    opId?: string,
  ): Promise<ImportResult> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const formData = new FormData();
    formData.append('file', file);
    formData.append('conflict', conflict);
    formData.append('external_conflict', externalConflict || 'reject');
    if (opId) {
      formData.append('op_id', opId);
    }
    if (selectedIds && selectedIds.length > 0) {
      formData.append('selected_ids', JSON.stringify(selectedIds));
    }

    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/import`,
      {
        method: 'POST',
        headers: { Authorization: authorization },
        body: formData,
      }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 409 && err.detail?.type === 'external_conflict') {
        throw new ExternalConflictError(
          err.detail.conflict_count || 0,
          err.detail.message || 'Receipts belong to another account'
        );
      }
      throw new Error(err.detail || 'Import failed');
    }
    return response.json();
  },

  /** Delete a backup */
  async deleteBackup(backupId: string): Promise<void> {
    const authorization = await getAuthHeader();
    const userId = getUserId();
    const response = await fetch(
      `${API_BASE_URL}/users/${userId}/backup/${backupId}`,
      { method: 'DELETE', headers: { Authorization: authorization } }
    );
    if (!response.ok) throw new Error('Delete failed');
  },
};
