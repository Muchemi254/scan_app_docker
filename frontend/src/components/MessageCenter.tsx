import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, X, Send, Plus, ChevronLeft, Shield, MessageCircle } from 'lucide-react';
import { messagesApi, Conversation, Message, Peer } from '../services/messagesApi';
import { useAuthStore } from '../stores/authStore';
import { useToastStore } from '../stores/toastStore';
import { useMessageStream } from '../hooks/useMessageStream';

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

/**
 * Slide-over message center: conversation list (left) + thread (right).
 * New messages arrive instantly via SSE; the thread auto-marks itself read
 * when opened. Rejection auto-messages (kind=reject) render with their
 * structured payload (supplier / total / invoice / note).
 */
const MessageCenter = ({ open, onClose, onUnreadChange }: MessageCenterProps) => {
  const user = useAuthStore(s => s.user);
  const toast = useToastStore(s => s.push);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [newPeerUid, setNewPeerUid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

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
      loadConversations();
    } else {
      setActiveId(null);
      setMessages([]);
      setComposing(false);
      setNewPeerUid(null);
    }
  }, [open, loadConversations]);

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

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    const recipient = activePeerUid();
    if (!recipient) return;
    setSending(true);
    try {
      const msg = await messagesApi.send(recipient, text);
      setDraft('');
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

  // When replying inside a thread, the recipient is the thread's other user.
  const activePeerUid = () => {
    if (activeId) {
      const conv = conversations.find(c => c.id === activeId);
      if (conv) return conv.other_user.uid;
    }
    return newPeerUid;
  };

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
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{activeName()}</p>
                {contentFor(conversations.find(c => c.id === activeId))}
              </div>
            </div>

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
              className="flex items-center gap-2 px-3 py-3 border-t bg-white"
              onSubmit={(e) => { e.preventDefault(); send(); }}
            >
              <input
                value={draft}
                onChange={e => setDraft(e.target.value)}
                placeholder="Write a message…"
                maxLength={4000}
                className="flex-1 px-3 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim() || sending}
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
                      <p className="text-xs text-blue-500 mt-0.5">
                        <MessageCircle className="h-3 w-3 inline mr-0.5 -mt-0.5" />
                        Receipt {c.receipt_id.slice(0, 8)}
                      </p>
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
                  {!user?.is_admin && (
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
    return (
      <p className="text-xs text-blue-500 truncate">
        <MessageCircle className="h-3 w-3 inline mr-0.5 -mt-0.5" />
        Receipt {conv.receipt_id.slice(0, 8)}
        {conv.kind === 'receipt' ? ' · auto thread' : ''}
      </p>
    );
  }
};

/** One message bubble; reject/system auto-messages show their payload. */
function MessageBubble({ m, mine }: { m: Message; mine: boolean }) {
  const isReject = m.kind === 'reject';
  const isSystem = m.kind === 'system';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm shadow-sm ${
        mine ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white border rounded-bl-sm'
      }`}>
        {isReject && (
          <p className={`text-xs font-semibold mb-1 ${mine ? 'text-blue-100' : 'text-red-500'}`}>
            Rejected{typeof m.payload?.receipt_id === 'string' ? ` · ${m.payload.receipt_id.slice(0, 8)}` : ''}
          </p>
        )}
        {isSystem && (
          <p className={`text-xs font-semibold mb-1 ${mine ? 'text-blue-100' : 'text-gray-400'}`}>System</p>
        )}
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        {isReject && m.payload && (
          <div className={`mt-2 text-xs rounded-lg px-3 py-2 ${mine ? 'bg-blue-500/40' : 'bg-gray-50 border'}`}>
            {m.payload.supplier && <p>Supplier: <span className="font-medium">{m.payload.supplier}</span></p>}
            {m.payload.total && <p>Total: <span className="font-medium">{m.payload.total}</span></p>}
            {m.payload.receipt_date && <p>Date: <span className="font-medium">{m.payload.receipt_date}</span></p>}
            {m.payload.invoice_number && <p>Invoice: <span className="font-medium">{m.payload.invoice_number}</span></p>}
            {m.payload.note && (
              <p className="mt-1">Note: <span className="font-medium">{m.payload.note}</span></p>
            )}
          </div>
        )}
        <p className={`text-[10px] mt-1 ${mine ? 'text-blue-200' : 'text-gray-400'}`}>{timeFmt(m.created_at)}</p>
      </div>
    </div>
  );
}

export default MessageCenter;