import { getAuthHeader } from './authUtils';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export interface OpProgress {
  op_id: string;
  op_type: 'import' | 'user_delete';
  owner: string;
  status: 'running' | 'completed' | 'failed';
  stage: string;
  message: string;
  total: Record<string, number>;
  counts: Record<string, number>;
  errors: number;
  result?: any;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
}

function newOpId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const opsApi = {
  newOpId,

  /** Poll one operation's live progress */
  async getOp(opId: string): Promise<OpProgress> {
    const resp = await fetch(`${API_BASE_URL}/ops/${encodeURIComponent(opId)}`, {
      headers: { Authorization: getAuthHeader() },
    });
    if (!resp.ok) throw new Error('Failed to load operation progress');
    return resp.json();
  },

  /** Recent operations for the current user (imports) or admin deletes */
  async recent(opType?: string): Promise<OpProgress[]> {
    const q = opType ? `?op_type=${encodeURIComponent(opType)}` : '';
    const resp = await fetch(`${API_BASE_URL}/ops/recent${q}`, {
      headers: { Authorization: getAuthHeader() },
    });
    if (!resp.ok) throw new Error('Failed to load recent operations');
    return resp.json();
  },
};