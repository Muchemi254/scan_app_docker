import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare, X, Send, Plus, ChevronLeft, Shield, MessageCircle,
  Check, XCircle, ExternalLink, Wand2,
} from 'lucide-react';
import {
  messagesApi, type Conversation, type Message, type Peer, type MessageKind, type MessageTemplate,
} from '../services/messagesApi';
import { receiptApi } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useToastStore } from '../stores/toastStore';
import { useMessageStream } from '../hooks/useMessageStream';
import { receiptStatusLabel, receiptStatusClass } from '../utils/receiptStatus';

interface MessageCenterProps {
  open: boolean;
  onClose: () => void;
  /** Called whenever the global unread badge changes (from the drawer). */
  onUnreadChange?: (unread: number) => void;
}

const timeFmt = (ts: number | null) => {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const KIND_HEADERS: Partial<Record<MessageKind, { label: string; cls: string }>> = {
  reject: { label: 'Rejected', cls: 'text-red-500' },
  receipt_rejection: { label: 'Rejected', cls: 'text-red-500' },
  receipt_approval: { label: 'Approved', cls: 'text-green-600' },
  receipt_question: { label: 'Question', cls: 'text-amber-600' },
  receipt_missing_info: { label: 'Missing information', cls: 'text-orange-600' },
  receipt_duplicate: { label: 'Possible duplicate', cls: 'text-purple-600' },
  receipt_payment: { label: 'Payment notice', cls: 'text-blue-600' },
  receipt_submit: { label: 'Submitted for approval', cls: 'text-blue-600' },
  receipt_recall: { label: 'Recalled', cls: 'text-gray-500' },
  system: { label: 'System', cls: 'text-gray-400' },
};

/** Render a template body with the supplied variables (client preview only;
 * the server re-renders canonically when sending with template_key). */
const renderTemplateBody = (body: string, vars: Record<string, string>) =>
  body.replace(/\{(\w+)\}/g, (_, name) => vars[name]?.trim() ? vars[name] : '—');

/**
 * Slide-over message center: conversation list (left) + thread (right).
 * New messages arrive instantly via SSE; the thread auto-marks itself read
 * when opened. Receipt threads show the receipt's live status and let admins
 * approve / reject / jump to the receipt without leaving the drawer.
 * Predefined templates (server catalog) are available from the composer.
 */
const MessageCenter = ({ open, onClose, onUnreadChange }: MessageCenterProps) => {
  const user = useAuthStore(s => s.user);
  const toast = useToastStore(s => s.push);
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [newPeerUid, setNewPeerUid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateMsg, setTemplateMsg] = useState<{ key: string; variables: Record<string, string>; preview: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [approving, setApproving] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLDivElement>(null);

  // Keep the unread callback behind a ref so `loadConversations` can stay
  // referentially stable: otherwise every badge update re-runs the
  // drawer-open effect and kicks the user out of an open thread.
  const onUnreadChangeRef = useRef(onUnreadChange);
  useEffect(() => {
    onUnreadChangeRef.current = onUnreadChange;
  }, [onUnreadChange]);

  const loadConversations = useCallback(async () => {
    try {
      const list = await messagesApi.conversations();
      setConversations(list);
      const unread = list.reduce((n, c) => n + c.unread_count, 0);
      onUnreadChangeRef.current?.(unread);
    } catch {
      /* badge polling is the fallback */
    }
  }, []);

  // Reset the drawer when it closes and load threads when it opens.
  // Resetting on close is what prevents a stale `activeId` from auto-marking
  // messages read while the user is on another page.
  useEffect(() => {
    if (open) {
      setActiveId(null);
      setMessages([]);
      setComposing(false);
      setNewPeerUid(null);
      setTemplateMsg(null);
      loadConversations();
      if (user?.is_admin) {
        messagesApi.templates().then(setTemplates).catch(() => {});
      }
    } else {
      setActiveId(null);
      setMessages([]);
      setComposing(false);
      setNewPeerUid(null);
      setTemplateMsg(null);
    }
  }, [open, loadConversations, user?.is_admin]);

  // Auto-mark the active thread read + focus the reply box. Only while the
  // drawer is actually open — a lingering activeId must never mark messages
  // read from another page.
  useEffect(() => {
    if (!open || !activeId) return;
    let cancelled = false;
    (async () => {
      try {
        const msgs = await messagesApi.messages(activeId);
        if (!cancelled) setMessages(msgs);
        const unreadIds = msgs.filter(m => !m.read && m.recipient_id === user?.uid).map(m => m.id);
        if (unreadIds.length) {
          await messagesApi.markRead(unreadIds);
          loadConversations();
        }
      } catch { /* keep previous */ }
    })();
    return () => { cancelled = true; };
  }, [open, activeId, user?.uid, loadConversations]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeId]);

  // SSE: instant delivery while the drawer is open (or badge bump otherwise).
  useMessageStream((ev) => {
    if (ev.type !== 'message' || !ev.data) return;
    if (!open) return; // Layout handles the badge/toast when the drawer is closed
    if (activeId && ev.data.conversation_id === activeId) {
      messagesApi.messages(activeId).then(setMessages).catch(() => {});
    } else {
      loadConversations();
      toast('info', 'New message', 'You have a new message', { duration: 4000 });
    }
  });

  // Close the template dropdown on outside click.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) {
        setTemplatesOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isAdmin = !!user?.is_admin;

  // Thread context — who owns the linked receipt and who we talk to.
  const activeConv = () =>
    activeId ? conversations.find(c => c.id === activeId) : undefined;

  const activePeerUidForSend = () => {
    const conv = activeConv();
    if (conv) return conv.other_user.uid;
    return newPeerUid;
  };

  const receiptOwnerUid = () => {
    const conv = activeConv();
    if (!conv?.receipt_id) return null;
    // Receipt threads pair the owner with an admin. For admins the other side
    // is the owner; for the owner the receipt belongs to them.
    return isAdmin ? conv.other_user.uid : user?.uid ?? null;
  };

  const receiptVars = (): Record<string, string> => {
    const conv = activeConv();
    if (!conv?.receipt_id) return {};
    return {
      supplier: conv.receipt_supplier || '',
      total: conv.receipt_total || '',
      date: conv.receipt_date || '',
      receipt_id: conv.receipt_id.slice(0, 8),
    };
  };

  const applyTemplate = (t: MessageTemplate) => {
    const vars = receiptVars();
    const preview = renderTemplateBody(t.body, vars);
    setDraft(preview);
    setTemplateMsg({ key: t.key, variables: vars, preview });
    setTemplatesOpen(false);
  };

  const onDraftChange = (v: string) => {
    setDraft(v);
    // Once the admin tweaks the preview text we fall back to a plain message.
    if (templateMsg && v !== templateMsg.preview) setTemplateMsg(null);
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && !templateMsg) || sending) return;
    const recipient = activePeerUidForSend();
    if (!recipient) return;
    setSending(true);
    try {
      const conv = activeConv();
      const msg = templateMsg
        ? await messagesApi.sendTemplate(
            recipient, templateMsg.key, templateMsg.variables,
            conv?.receipt_id || undefined,
          )
        : await messagesApi.send(recipient, text);
      setDraft('');
      setTemplateMsg(null);
      if (msg.conversation_id) {
        setNewPeerUid(null);
        setActiveId(msg.conversation_id);
        setMessages(prev => [...prev, msg]);
        loadConversations();
      }
    } catch (e: any) {
      toast('error', 'Message failed', e?.message || 'Could not send message');
    } finally {
      setSending(false);
    }
  };

  const confirmApprove = async () => {
    const owner = receiptOwnerUid();
    const conv = activeConv();
    if (!owner || !conv?.receipt_id || approving) return;
    setApproving(true);
    try {
      await receiptApi.approve(owner, conv.receipt_id);
      toast('success', 'Receipt approved', `${conv.receipt_supplier || 'Receipt'} approved and processed`);
      loadConversations();
      messagesApi.messages(conv.id).then(setMessages).catch(() => {});
    } catch (e: any) {
      toast('error', 'Approval failed', e?.message || 'Could not approve receipt');
    } finally {
      setApproving(false);
    }
  };

  const confirmReject = async () => {
    const owner = receiptOwnerUid();
    const conv = activeConv();
    if (!owner || !conv?.receipt_id || rejecting) return;
    setRejecting(true);
    try {
      await receiptApi.reject(owner, conv.receipt_id, rejectNote.trim() || undefined);
      toast('success', 'Receipt rejected', 'The owner was notified');
      setRejectNote('');
      setRejecting(false);
      loadConversations();
      messagesApi.messages(conv.id).then(setMessages).catch(() => {});
    } catch (e: any) {
      setRejecting(false);
      toast('error', 'Rejection failed', e?.message || 'Could not reject receipt');
    }
  };

  const viewReceipt = () => {
    const conv = activeConv();
    if (!conv?.receipt_id) return;
    if (isAdmin) {
      navigate(`/approvals?receipt=${conv.receipt_id}`);
    } else {
      const target = conv.receipt_status === 'needs_review'
        ? `/review?receipt=${conv.receipt_id}`
        : `/my-approvals?receipt=${conv.receipt_id}`;
      navigate(target);
    }
    onClose();
  };

  // When replying inside a thread, the recipient is the thread's other user.
  const startCompose = async () => {
    setComposing(true);
    setNewPeerUid(null);
    try {
      setPeers(await messagesApi.peers());
    } catch {
      setComposing(false);
    }
  };

  const openPeer = (uid: string) => {
    const existing = conversations.find(
      c => c.other_user.uid === uid && c.kind === 'pair'
    );
    setComposing(false);
    setMessages([]);
    if (existing) {
      setNewPeerUid(null);
      setActiveId(existing.id);
    } else {
      // No thread yet — open a fresh one with this peer so the first
      // message can be sent immediately.
      setActiveId(null);
      setNewPeerUid(uid);
    }
  };

  const backToList = () => {
    setActiveId(null);
    setNewPeerUid(null);
    setMessages([]);
    setTemplateMsg(null);
    setRejectNote('');
  };

  return (
    <div className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/30 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      {/* Panel */}
      <div className={`absolute right-0 top-0 h-full w-full max-w-lg bg-white shadow-2xl flex flex-col transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b bg-white">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-blue-600" />
            Messages
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {(activeId || newPeerUid) && !composing ? (
          /* ── Thread view ── */
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50">
              <button
                onClick={backToList}
                className="p-1 rounded text-gray-500 hover:bg-gray-200"
                aria-label="Back to conversations"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">{activeName()}</p>
                  {receiptChip(activeConv())}
                </div>
                {contentFor(activeConv())}
              </div>
              {/* Receipt-scoped quick actions (admin) */}
              {isAdmin && activeConv()?.receipt_id && (
                <div className="flex items-center gap-1 shrink-0">
                  {activeConv()?.receipt_status === 'pending_approval' && (
                    <>
                      <button
                        onClick={confirmApprove}
                        disabled={approving}
                        title="Approve receipt"
                        className="p-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setRejecting(true)}
                        disabled={rejecting}
                        title="Reject receipt"
                        className="p-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-40"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </>
                  )}
                  <button
                    onClick={viewReceipt}
                    title="Open receipt"
                    className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                </div>
              )}
              {!isAdmin && activeConv()?.receipt_id && (
                <button
                  onClick={viewReceipt}
                  title="Open receipt"
                  className="p-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 shrink-0"
                >
                  <ExternalLink className="h-4 w-4" />
                </button>
              )}
            </div>

            {rejecting && isAdmin && activeConv()?.receipt_status === 'pending_approval' && (
              <div className="px-3 py-2 border-b bg-red-50 flex items-center gap-2">
                <input
                  value={rejectNote}
                  onChange={e => setRejectNote(e.target.value)}
                  placeholder="Rejection reason (optional)…"
                  maxLength={1000}
                  className="flex-1 px-3 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-red-500 outline-none"
                />
                <button
                  onClick={confirmReject}
                  disabled={rejecting}
                  className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-40"
                >
                  Reject
                </button>
                <button
                  onClick={() => { setRejecting(false); setRejectNote(''); }}
                  className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
                  aria-label="Cancel reject"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50">
              {messages.map(m => (
                <MessageBubble key={m.id} m={m} mine={m.sender_id === user?.uid} />
              ))}
              {messages.length === 0 && (
                <p className="text-center text-sm text-gray-400 mt-8">No messages yet — say hello!</p>
              )}
              <div ref={threadEndRef} />
            </div>

            <form
              className="flex items-end gap-2 px-3 py-3 border-t bg-white"
              onSubmit={(e) => { e.preventDefault(); send(); }}
            >
              <div className="flex-1">
                {isAdmin && (
                  <div ref={templateRef} className="relative mb-2">
                    {templateMsg && (
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-blue-600">
                        <MessageCircle className="h-3 w-3" />
                        Template: {templates.find(t => t.key === templateMsg.key)?.title || templateMsg.key}
                        <button
                          type="button"
                          onClick={() => { setTemplateMsg(null); setDraft(''); }}
                          className="text-gray-400 hover:text-gray-600"
                          aria-label="Clear template"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setTemplatesOpen(o => !o)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                      >
                        <Wand2 className="h-3.5 w-3.5" /> Templates
                      </button>
                      {templatesOpen && (
                        <div className="absolute left-0 bottom-full mb-1 w-72 max-h-56 overflow-y-auto bg-white border rounded-lg shadow-lg z-10">
                          {templates.map(t => (
                            <button
                              key={t.key}
                              type="button"
                              onClick={() => applyTemplate(t)}
                              className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-0"
                            >
                              <p className="text-sm font-medium text-gray-800">{t.title}</p>
                              <p className="text-xs text-gray-500 truncate">{t.description}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <textarea
                  value={draft}
                  onChange={e => onDraftChange(e.target.value)}
                  placeholder={templateMsg ? 'Ready to send template…' : 'Write a message…'}
                  maxLength={4000}
                  rows={templateMsg ? 3 : 1}
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                />
              </div>
              <button
                type="submit"
                disabled={(!draft.trim() && !templateMsg) || sending}
                className="p-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </>
        ) : composing ? (
          /* ── New conversation picker ── */
          <>
            <div className="flex items-center gap-2 px-3 py-2 border-b bg-gray-50">
              <button onClick={() => setComposing(false)} className="p-1 rounded text-gray-500 hover:bg-gray-200" aria-label="Back">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <p className="text-sm font-medium">Start a conversation</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {peers.map(p => (
                <button
                  key={p.uid}
                  onClick={() => openPeer(p.uid)}
                  className="w-full flex items-center gap-3 px-4 py-3 border-b text-left hover:bg-gray-50"
                >
                  <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 text-xs font-bold">
                    {(p.display_name || p.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.display_name || p.email}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {p.is_admin ? 'Admin' : 'User'} · {p.email}
                    </p>
                  </div>
                </button>
              ))}
              {peers.length === 0 && (
                <p className="text-center text-sm text-gray-400 mt-8">No one to message yet.</p>
              )}
            </div>
          </>
        ) : (
          /* ── Conversation list ── */
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b">
              <button
                onClick={startCompose}
                className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                <Plus className="h-4 w-4" /> New message
              </button>
              <span className="text-xs text-gray-400">
                {conversations.reduce((n, c) => n + c.unread_count, 0)} unread
              </span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {conversations.map(c => (
                <button
                  key={c.id}
                  onClick={() => { setActiveId(c.id); }}
                  className="w-full flex items-start gap-3 px-4 py-3 border-b text-left hover:bg-gray-50"
                >
                  <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 text-xs font-bold shrink-0">
                    {(c.other_user.display_name || c.other_user.email || '?')[0].toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium truncate">
                        {c.other_user.display_name || c.other_user.email}
                        {c.other_user.is_admin && (
                          <Shield className="h-3.5 w-3.5 inline ml-1 text-blue-500 -mt-0.5" />
                        )}
                      </p>
                      <span className="text-xs text-gray-400 shrink-0">{timeFmt(c.last_message_at)}</span>
                    </div>
                    <p className={`text-sm truncate ${c.unread_count ? 'text-gray-900 font-medium' : 'text-gray-500'}`}>
                      {c.last_message?.body || 'No messages yet'}
                    </p>
                    {c.receipt_id && (
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-xs text-blue-500">
                          <MessageCircle className="h-3 w-3 inline mr-0.5 -mt-0.5" />
                          {c.receipt_supplier || `Receipt ${c.receipt_id.slice(0, 8)}`}
                        </span>
                        {receiptChip(c)}
                      </div>
                    )}
                  </div>
                  {c.unread_count > 0 && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center shrink-0">
                      {c.unread_count > 99 ? '99+' : c.unread_count}
                    </span>
                  )}
                </button>
              ))}
              {conversations.length === 0 && (
                <div className="text-center py-12 px-6">
                  <MessageSquare className="h-8 w-8 mx-auto text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">No conversations yet.</p>
                  {!isAdmin && (
                    <p className="text-xs text-gray-400 mt-1">Admins will message you when they review your receipts.</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  function receiptChip(conv?: Conversation) {
    if (!conv?.receipt_id) return null;
    return (
      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${conv.receipt_status ? receiptStatusClass(conv.receipt_status) : 'bg-gray-100 text-gray-600'}`}>
        {conv.receipt_status ? receiptStatusLabel(conv.receipt_status) : 'Receipt'}
      </span>
    );
  }

  function activeName(): string {
    if (activeId) {
      const conv = conversations.find(c => c.id === activeId);
      if (conv) return conv.other_user.display_name || conv.other_user.email || 'Conversation';
    }
    // Fresh thread before the first message: name from the peer picker.
    const peer = peers.find(p => p.uid === newPeerUid);
    return peer?.display_name || peer?.email || 'Conversation';
  }

  function contentFor(conv?: Conversation) {
    if (!conv?.receipt_id) return null;
    const bits = [
      `Receipt ${conv.receipt_id.slice(0, 8)}`,
      conv.receipt_total ? `KES ${Number(conv.receipt_total).toLocaleString()}` : null,
      conv.receipt_item_count ? `${conv.receipt_item_count} item${conv.receipt_item_count === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    return (
      <p className="text-xs text-gray-500 truncate">
        <MessageCircle className="h-3 w-3 inline mr-0.5 -mt-0.5 text-blue-500" />
        {bits.join(' · ')}
      </p>
    );
  }
};

/** One message bubble; receipt-system messages show their structured payload. */
function MessageBubble({ m, mine }: { m: Message; mine: boolean }) {
  const kindMeta = KIND_HEADERS[m.kind];
  const payload = m.payload || {};
  const total = payload.total_amount ?? payload.total;

  const thumbnailUrl: string | null = payload.thumbnail_url
    || (payload.receipt_id && payload.has_image
      ? `/receipt-images/${payload.receipt_id}?thumb=1`
      : null);

  const payloadRows = [
    payload.supplier && ['Supplier', payload.supplier],
    total != null && ['Total', `KES ${Number(total).toLocaleString()}`],
    payload.receipt_date && ['Date', String(payload.receipt_date)],
    payload.invoice_number && ['Invoice', payload.invoice_number],
    payload.field && ['Missing', payload.field],
    payload.duplicate_invoice && ['Duplicate of', payload.duplicate_invoice],
    payload.payment_status && ['Payment', payload.payment_status],
    payload.line_items_count != null && ['Items', String(payload.line_items_count)],
    payload.note && ['Note', payload.note],
  ].filter(Boolean) as [string, string][];

  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm shadow-sm ${
        mine ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border rounded-bl-sm'
      }`}>
        {kindMeta && (
          <p className={`text-xs font-semibold mb-1 ${mine ? 'text-blue-100' : kindMeta.cls}`}>
            {kindMeta.label}
            {typeof payload.receipt_id === 'string' ? ` · ${payload.receipt_id.slice(0, 8)}` : ''}
          </p>
        )}
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt="receipt"
            className="w-16 h-16 object-cover rounded-lg mb-2 border"
            loading="lazy"
          />
        )}
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        {payloadRows.length > 0 && (
          <div className={`mt-2 text-xs rounded-lg px-3 py-2 space-y-0.5 ${mine ? 'bg-blue-500/40' : 'bg-gray-50 border'}`}>
            {payloadRows.map(([label, value]) => (
              <p key={label}>
                <span className="font-medium">{label}:</span> {value}
              </p>
            ))}
          </div>
        )}
        <p className={`text-[10px] mt-1 ${mine ? 'text-blue-200' : 'text-gray-400'}`}>{timeFmt(m.created_at)}</p>
      </div>
    </div>
  );
}

export default MessageCenter;