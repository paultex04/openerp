/**
 * Unit coverage for the chat event bus (Phase 17, step 2).
 *
 * The bus is pure in-memory state, so it needs no database. The integration suite
 * covers the routes that publish to it; this covers the fan-out and presence
 * bookkeeping in isolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isOnline,
  onlineUserIds,
  publishTo,
  resetChatBus,
  subscribe,
  handleRemoteNotification,
  INSTANCE_ID,
  type ChatServerEvent,
} from './events.js';

afterEach(() => resetChatBus());

function collect(): { events: ChatServerEvent[]; listener: (event: ChatServerEvent) => void } {
  const events: ChatServerEvent[] = [];
  return { events, listener: (event) => events.push(event) };
}

describe('chat event bus', () => {
  it('delivers an event to every listener of a targeted account', () => {
    const a = collect();
    const b = collect();
    subscribe(1, a.listener);
    subscribe(1, b.listener);
    // Subscribing announces presence to the new listener; ignore that frame.
    a.events.length = 0;
    b.events.length = 0;

    publishTo([1], { type: 'typing', conversationId: 5, userId: 1, isTyping: true });

    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it('does not deliver to an account with no listener', () => {
    const a = collect();
    subscribe(1, a.listener);
    a.events.length = 0;

    publishTo([2], { type: 'typing', conversationId: 5, userId: 2, isTyping: true });

    expect(a.events).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const a = collect();
    const unsubscribe = subscribe(1, a.listener);
    unsubscribe();
    a.events.length = 0;

    publishTo([1], { type: 'typing', conversationId: 5, userId: 1, isTyping: true });

    expect(a.events).toHaveLength(0);
  });

  it('announces presence on the first listener and the last removal', () => {
    const watcher = collect();
    subscribe(2, watcher.listener);
    // The watcher hears its own "online"; clear it so only account 1 is observed.
    watcher.events.length = 0;

    const first = subscribe(1, () => undefined);
    expect(watcher.events).toEqual([{ type: 'presence', userId: 1, online: true }]);

    // A second stream for the same account is not a second "came online".
    const second = subscribe(1, () => undefined);
    expect(watcher.events).toHaveLength(1);

    second();
    expect(watcher.events).toHaveLength(1);

    first();
    expect(watcher.events).toEqual([
      { type: 'presence', userId: 1, online: true },
      { type: 'presence', userId: 1, online: false },
    ]);
  });

  it('reports the online snapshot, excluding the caller on request', () => {
    subscribe(1, () => undefined);
    subscribe(2, () => undefined);

    expect(isOnline(1)).toBe(true);
    expect(isOnline(9)).toBe(false);
    expect(onlineUserIds(1)).toEqual([2]);
    expect(onlineUserIds()).toEqual([1, 2]);
  });

  it('keeps fanning out when one listener throws', () => {
    const good = collect();
    subscribe(1, () => {
      throw new Error('socket closed');
    });
    subscribe(1, good.listener);

    expect(() =>
      publishTo([1], { type: 'typing', conversationId: 1, userId: 1, isTyping: true }),
    ).not.toThrow();
    expect(good.events).toHaveLength(1);
  });

  describe('PostgreSQL LISTEN/NOTIFY multi-instance sync', () => {
    it('ignores notifications originating from the current instance to prevent duplicate dispatch', () => {
      const a = collect();
      subscribe(1, a.listener);
      a.events.length = 0;

      const selfPayload = JSON.stringify({
        instanceId: INSTANCE_ID,
        targetUserIds: [1],
        event: { type: 'presence', userId: 2, online: true },
      });

      handleRemoteNotification(selfPayload);
      expect(a.events).toHaveLength(0);
    });

    it('dispatches targeted notifications from another instance to matching local subscribers', () => {
      const u1 = collect();
      const u2 = collect();
      subscribe(1, u1.listener);
      subscribe(2, u2.listener);
      u1.events.length = 0;
      u2.events.length = 0;

      const remotePayload = JSON.stringify({
        instanceId: 'remote-instance-uuid-456',
        targetUserIds: [2],
        event: { type: 'typing', conversationId: 10, userId: 1, isTyping: true },
      });

      handleRemoteNotification(remotePayload);
      expect(u1.events).toHaveLength(0);
      expect(u2.events).toHaveLength(1);
      expect(u2.events[0]).toEqual({
        type: 'typing',
        conversationId: 10,
        userId: 1,
        isTyping: true,
      });
    });

    it('dispatches broadcast notifications from another instance to all local subscribers', () => {
      const u1 = collect();
      const u2 = collect();
      subscribe(1, u1.listener);
      subscribe(2, u2.listener);
      u1.events.length = 0;
      u2.events.length = 0;

      const remoteBroadcast = JSON.stringify({
        instanceId: 'remote-instance-uuid-789',
        targetUserIds: null,
        event: { type: 'presence', userId: 99, online: true },
      });

      handleRemoteNotification(remoteBroadcast);
      expect(u1.events).toEqual([{ type: 'presence', userId: 99, online: true }]);
      expect(u2.events).toEqual([{ type: 'presence', userId: 99, online: true }]);
    });

    it('silently ignores invalid JSON payloads without throwing', () => {
      expect(() => handleRemoteNotification('not-valid-json')).not.toThrow();
    });
  });
});
