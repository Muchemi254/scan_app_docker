/**
 * Messages API - user <-> admin chat.
 *
 * Endpoints are NOT user-scoped (no /users/{uid} prefix): the server derives
 * the caller from the JWT. An authenticated user can only ever interact with
 * conversations they participate in (enforced server-side).
 */

import { getAuthHeader } from './auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

export interface ConversationOtherUser {
  uid: string;
  email: string | null;
  display_name: string | null;
  is_admin: boolean;
}

export interface Conversation {
  id: string;
  receipt_id: string | null;
  kind: 'pair' | 'receipt';
  receipt_status: 'needs_review' | 'pending_approval' | 'processed' | null;
  receipt_supplier: string | null;
  receipt_total: string | null;
  receipt_date: string | null;
  receipt_item_count: number;
  receipt_has_image: boolean;
  last_message_at: number | null;
  created_at: number | null;
  other_user: ConversationOtherUser;
  last_message: { body: string; sender_id: string } | null;
  unread_count: number;
}

export type MessageKind =
  | 'message'
  | 'system'
  | 'reject'
  | 'receipt_submit'
  | 'receipt_recall'
  | 'receipt_approval'
  | 'receipt_rejection'
  | 'receipt_question'
  | 'receipt_duplicate'
  | 'receipt_missing_info'
  | 'receipt_payment';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  recipient_id: string;
  body: string;
  kind: MessageKind;
  payload: Record<string, any>;
  read: boolean;
  created_at: number | null;
}

export interface MessageTemplate {
  key: string;
  kind: MessageKind;
  title: string;
  description: string;
  body: string;
  variables: string[];
}

export interface Peer {
  uid: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
}

async function api<T>(method: string, endpoint: string, data?: any): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/messages${endpoint}`, {
    method,
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  if (!response.ok) {
    let detail = `API error: ${response.status}`;
    try {
      const error = await response.json();
      detail = error.detail || detail;
    } catch { /* non-JSON error body */ }
    throw new Error(detail);
  }

  if (response.status === 204) return undefined as any;
  return response.json();
}

export const messagesApi = {
  /** List the caller's conversations, newest first. */
  async conversations(): Promise<Conversation[]> {
    return api('GET', '/conversations');
  },

  /** Messages of one conversation, oldest first. */
  async messages(conversationId: string, before?: number): Promise<Message[]> {
    const qs = before ? `?before=${before}` : '';
    return api('GET', `/conversations/${conversationId}/messages${qs}`);
  },

  /** Mark the whole conversation read; returns how many were marked. */
  async markConversationRead(conversationId: string): Promise<{ marked: number }> {
    return api('POST', `/conversations/${conversationId}/read`);
  },

  /** Mark specific messages read (only where the caller is the recipient). */
  async markRead(messageIds: string[]): Promise<{ marked: number }> {
    return api('POST', '/read', { message_ids: messageIds });
  },

  /** Total unread across all conversations. */
  async unreadCount(): Promise<{ unread: number }> {
    return api('GET', '/unread-count');
  },

  /** Who the caller may start a conversation with. */
  async peers(): Promise<Peer[]> {
    const res: { peers: Peer[] } = await api('GET', '/peers');
    return res.peers;
  },

  /** Send a message. Returns the created message. */
  async send(recipientUid: string, body: string): Promise<Message> {
    return api('POST', '/send', { recipient_uid: recipientUid, body });
  },

  /** The predefined receipt message templates (server-side catalog). */
  async templates(): Promise<MessageTemplate[]> {
    const res: { templates: MessageTemplate[] } = await api('GET', '/templates');
    return res.templates;
  },

  /** Send a predefined template; the server renders body + kind canonically. */
  async sendTemplate(
    recipientUid: string,
    templateKey: string,
    variables: Record<string, string>,
    receiptId?: string,
  ): Promise<Message> {
    return api('POST', '/send', {
      recipient_uid: recipientUid,
      template_key: templateKey,
      variables,
      ...(receiptId ? { receipt_id: receiptId } : {}),
    });
  },
};