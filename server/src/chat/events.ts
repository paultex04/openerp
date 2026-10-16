/**
 * In-process chat event bus (Phase 17, step 2).
 *
 * The live channel fans events out to connected accounts. This is deliberately a
 * plain in-memory registry rather than Redis or Postgres `LISTEN`: Coolify runs a
 * single API instance, so one process holds every open stream and a pub/sub
 * broker would be infrastructure with no second subscriber to justify it. The day
 * a second API instance is added, this module is the one place that has to change.
 *
 * Nothing here is persisted. Typing and presence are true only for as long as a
 * stream is open; a message or read event is a *notification* about a row that
 * was already written, so a dropped frame costs a stale view, never data. That is
 * also why the client keeps its polling fallback.
 *
 * A listener that throws (a socket closed mid-write, say) is swallowed: one dead
 * connection must not stop the fan-out to everyone else.
 */
import type { ChatMessageView } from './service.js';

export type ChatServerEvent =
  | { type: 'message'; conversationId: number; message: ChatMessageView }
  | { type: 'read'; conversationId: number; userId: number; lastReadAt: string }
  | { type: 'typing'; conversationId: number; userId: number; isTyping: boolean }
  | { type: 'presence'; userId: number; online: boolean };

export type ChatEventListener = (event: ChatServerEvent) => void;

/** Open streams, keyed by account. A set because one person may have many tabs. */
const listeners = new Map<number, Set<ChatEventListener>>();

function safeNotify(listener: ChatEventListener, event: ChatServerEvent): void {
  try {
    listener(event);
  } catch (error) {
    // Written as a statement rather than an empty block: a closed socket must not
    // interrupt the fan-out, but the intent should still read explicitly.
    void error;
  }
}

function broadcast(event: ChatServerEvent): void {
  for (const set of listeners.values()) {
    for (const listener of set) safeNotify(listener, event);
  }
}

/**
 * Registers a listener and returns its remover. The first listener for an account
 * announces it online; removing the last announces it offline.
 */
export function subscribe(userId: number, listener: ChatEventListener): () => void {
  const existing = listeners.get(userId);
  const wasOffline = !existing || existing.size === 0;
  const set = existing ?? new Set<ChatEventListener>();
  if (!existing) listeners.set(userId, set);
  set.add(listener);
  if (wasOffline) broadcast({ type: 'presence', userId, online: true });

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      listeners.delete(userId);
      broadcast({ type: 'presence', userId, online: false });
    }
  };
}

/** Delivers an event to the listeners of the given accounts, and no others. */
export function publishTo(userIds: Iterable<number>, event: ChatServerEvent): void {
  for (const userId of userIds) {
    const set = listeners.get(userId);
    if (!set) continue;
    for (const listener of set) safeNotify(listener, event);
  }
}

/** Account ids with at least one open stream, optionally excluding one (usually "me"). */
export function onlineUserIds(excludeUserId?: number): number[] {
  const ids: number[] = [];
  for (const [userId, set] of listeners) {
    if (set.size > 0 && userId !== excludeUserId) ids.push(userId);
  }
  return ids.sort((a, b) => a - b);
}

export function isOnline(userId: number): boolean {
  return (listeners.get(userId)?.size ?? 0) > 0;
}

/** Test-only: drop every subscriber so suites do not leak into one another. */
export function resetChatBus(): void {
  listeners.clear();
}
