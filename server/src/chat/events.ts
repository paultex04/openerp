/**
 * Chat event bus (Phase 17 & Phase 3).
 *
 * The live channel fans events out to connected accounts via Server-Sent Events (SSE).
 *
 * ## Multi-Instance Scalability with PostgreSQL LISTEN/NOTIFY
 *
 * In a multi-instance / scaled container deployment (or zero-downtime rolling deploys),
 * clients may be connected to different API instances. To ensure real-time delivery
 * across instances without requiring external dependencies like Redis:
 * - A dedicated PostgreSQL connection listens on channel `openerp_chat_events`.
 * - Local events (`broadcast` and `publishTo`) are dispatched immediately to local
 *   subscribers and published via `pg_notify` to sibling instances.
 * - Sibling instances receive the notification and fan out to their local listeners.
 * - Payloads include an `instanceId` so an instance ignores notifications it emitted itself.
 * - In test environments or when disconnected, it operates in memory with zero overhead.
 */
import pg from 'pg';
import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { ChatMessageView } from './service.js';

export const CHAT_CHANNEL = 'openerp_chat_events';
export const INSTANCE_ID = crypto.randomUUID();

export type ChatServerEvent =
  | { type: 'message'; conversationId: number; message: ChatMessageView }
  | { type: 'read'; conversationId: number; userId: number; lastReadAt: string }
  | { type: 'typing'; conversationId: number; userId: number; isTyping: boolean }
  | { type: 'presence'; userId: number; online: boolean }
  | { type: 'deleted'; conversationId: number };

export type ChatEventListener = (event: ChatServerEvent) => void;

interface RemotePayload {
  instanceId: string;
  targetUserIds: number[] | null;
  event: ChatServerEvent;
}

/** Open streams, keyed by account. A set because one person may have many tabs. */
const listeners = new Map<number, Set<ChatEventListener>>();

let listenClient: pg.Client | null = null;
let isClosed = false;
let reconnectTimer: NodeJS.Timeout | null = null;

function safeNotify(listener: ChatEventListener, event: ChatServerEvent): void {
  try {
    listener(event);
  } catch (error) {
    // A closed socket must not interrupt the fan-out, but intent remains explicit.
    void error;
  }
}

/** Delivers an incoming remote event to local listeners */
export function handleRemoteNotification(payloadStr: string): void {
  try {
    const payload = JSON.parse(payloadStr) as RemotePayload;
    if (payload.instanceId === INSTANCE_ID) return;

    if (payload.targetUserIds && Array.isArray(payload.targetUserIds)) {
      for (const userId of payload.targetUserIds) {
        const set = listeners.get(userId);
        if (!set) continue;
        for (const listener of set) safeNotify(listener, payload.event);
      }
    } else {
      for (const set of listeners.values()) {
        for (const listener of set) safeNotify(listener, payload.event);
      }
    }
  } catch {
    // Malformed JSON payload is ignored
  }
}

async function notifyRemote(event: ChatServerEvent, targetUserIds?: Iterable<number>): Promise<void> {
  if (!listenClient) return;
  try {
    const payload: RemotePayload = {
      instanceId: INSTANCE_ID,
      targetUserIds: targetUserIds ? Array.from(targetUserIds) : null,
      event,
    };
    const serialized = JSON.stringify(payload);
    // Postgres pg_notify maximum payload is 8000 bytes.
    if (Buffer.byteLength(serialized, 'utf8') > 7800) {
      return;
    }
    await listenClient.query('SELECT pg_notify($1, $2)', [CHAT_CHANNEL, serialized]);
  } catch {
    // Best-effort remote notification: local delivery has already occurred.
  }
}

function broadcast(event: ChatServerEvent): void {
  for (const set of listeners.values()) {
    for (const listener of set) safeNotify(listener, event);
  }
  void notifyRemote(event);
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
  void notifyRemote(event, userIds);
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

async function connectListener(connectionString: string): Promise<void> {
  if (listenClient || isClosed) return;

  const client = new pg.Client({ connectionString });

  client.on('notification', (msg) => {
    if (msg.channel === CHAT_CHANNEL && msg.payload) {
      handleRemoteNotification(msg.payload);
    }
  });

  client.on('error', () => {
    listenClient = null;
    if (!isClosed) {
      scheduleReconnect(connectionString);
    }
  });

  try {
    await client.connect();
    await client.query(`LISTEN ${CHAT_CHANNEL}`);
    listenClient = client;
  } catch {
    listenClient = null;
    if (!isClosed) {
      scheduleReconnect(connectionString);
    }
  }
}

function scheduleReconnect(connectionString: string): void {
  if (reconnectTimer || isClosed) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener(connectionString);
  }, 5000);
  reconnectTimer.unref();
}

export async function initChatBus(config: Config): Promise<void> {
  if (config.isTest) return;
  if (!config.DATABASE_URL) return;
  isClosed = false;
  await connectListener(config.DATABASE_URL);
}

export async function closeChatBus(): Promise<void> {
  isClosed = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenClient) {
    const client = listenClient;
    listenClient = null;
    try {
      await client.end();
    } catch {
      // ignore
    }
  }
}
