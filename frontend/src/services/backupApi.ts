import { getAuthHeader, getToken, getUserId } from './authUtils';

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
    audit_logs?: number;
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

/** Trigger a native browser download of a backup — streams straight to disk. */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'scanapp_backup.tar.gz';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export const backupApi = {
  /** Create a backup on the server, then download it natively (no blob buffering). */
  async exportBackup(onProgress?: (pct: number, status: string) => void): Promise<void> {
    const userId = getUserId();
    const url = `${API_BASE_URL}/users/${userId}/backup/export`;

    onProgress?.(5, 'Building archive on server…');
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: await getAuthHeader() },
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || 'Export failed');
    }

    const meta = await response.json();
    onProgress?.(70, 'Downloading…');

    // Headerless direct link — the browser streams the archive to disk,
    // so even multi-GB backups never sit in the tab's memory and there is
    // no blob: URL to revoke mid-download.
    const token = getToken();
    if (!token) throw new Error('Authentication failed');
    triggerDownload(
      `${API_BASE_URL}/users/${userId}/backup/download/${meta.id}?token=${encodeURIComponent(token)}`,
      meta.filename || 'scanapp_backup.tar.gz',
    );
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
    const userId = getUserId();
    const token = getToken();
    if (!token) throw new Error('Authentication failed');
    triggerDownload(
      `${API_BASE_URL}/users/${userId}/backup/download/${backupId}?token=${encodeURIComponent(token)}`,
      filename,
    );
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
