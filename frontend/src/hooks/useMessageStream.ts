/**
 * useMessageStream - Server-Sent Events hook for instant message delivery.
 *
 * Opens one EventSource per subscriber (keyed by channel name) and replays
 * the last event to every listener. EventSource cannot set Authorization
 * headers, so the backend accepts the same JWT via ?token=.
 */

import { useEffect, useRef } from 'react';
import { getToken, getUserId } from '../services/auth';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1';

interface StreamEvent {
  type: string;
  data?: { message_id: string; conversation_id: string; kind: string; sender_id: string };
}

const listeners = new Map<string, Set<(ev: StreamEvent) => void>>();
const sources = new Map<string, EventSource>();

function subscribe(channel: string, cb: (ev: StreamEvent) => void): () => void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
  }
  set.add(cb);

  if (!sources.has(channel)) {
    const token = getToken();
    const source = new EventSource(`${API_BASE_URL}/messages/stream?token=${encodeURIComponent(token || '')}`);
    sources.set(channel, source);

    source.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as StreamEvent;
        const subs = listeners.get(channel);
        if (subs) subs.forEach((fn) => fn(ev));
      } catch { /* ignore malformed frames */ }
    };
    source.onerror = () => {
      // EventSource auto-reconnects; treat as a heartbeat miss.
    };
  }

  return () => {
    const subs = listeners.get(channel);
    if (subs) {
      subs.delete(cb);
      if (subs.size === 0) {
        listeners.delete(channel);
        const src = sources.get(channel);
        if (src) {
          src.close();
          sources.delete(channel);
        }
      }
    }
  };
}

export function useMessageStream(onEvent: (ev: StreamEvent) => void): void {
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  useEffect(() => {
    const uid = getUserId();
    const channel = `messages:user:${uid}`;
    const off = subscribe(channel, (ev) => cbRef.current(ev));
    return off;
  }, []);
}