/**
 * Phase 17, step 1 acceptance gates, exercised against the live database.
 *
 *   1. A direct conversation is opened once and re-opening returns the same
 *      thread (the two account ids sorted are the key).
 *   2. Membership is the read boundary: a non-member gets a 404, not a 403, and
 *      never sees the conversation in their list.
 *   3. Unread is derived from `last_read_at`: a message from someone else counts
 *      until the recipient marks it read.
 *   4. A repeated `clientToken` is the same message, not a second one.
 *   5. History pages by keyset, oldest-first within a page.
 *   6. Chat needs `chat.read`; without it the surface is closed.
 *
 * Fixtures are created and torn down within the suite; nothing else is touched.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { prisma } from '../db/client.js';
import { TEST_PASSWORD, createTestUser, destroyTestUser, login } from '../test/fixtures.js';

let app: FastifyInstance;

interface TestUser {
  id: number;
  employeeId: number;
  email: string;
  cookie: string;
}

const users: TestUser[] = [];
const conversations: number[] = [];
const testRoles: string[] = [];

/**
 * A throwaway role with no grants.
 *
 * An account with *no* role at all is rejected during principal resolution (401,
 * `no_roles`), so the permission gate — the 403 this suite wants to see — needs
 * an account that holds a real role and simply lacks `chat.*`.
 */
async function makeRoleWithoutChat(): Promise<string> {
  const key = `test-nochat-${randomUUID().slice(0, 8)}`;
  await prisma.appRole.create({
    data: { key, name: 'Test: no chat', description: 'Throwaway role with no grants.' },
  });
  testRoles.push(key);
  return key;
}

/** An administrator so the run does not depend on a local role's custom grants. */
async function makeUser(roleKeys: string[]): Promise<TestUser> {
  const user = await createTestUser(roleKeys);
  const cookie = await login(app, user.email, TEST_PASSWORD);
  const entry: TestUser = {
    id: user.id,
    employeeId: user.employeeId,
    email: user.email,
    cookie,
  };
  users.push(entry);
  return entry;
}

async function openDm(from: TestUser, toUserId: number): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/chat/conversations',
    headers: { cookie: from.cookie },
    payload: { userId: toUserId },
  });
  expect(response.statusCode).toBe(201);
  const id = response.json().conversation.id as number;
  if (!conversations.includes(id)) conversations.push(id);
  return id;
}

function send(user: TestUser, conversationId: number, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/chat/conversations/${conversationId}/messages`,
    headers: { cookie: user.cookie },
    payload,
  });
}

function listConversations(user: TestUser) {
  return app.inject({
    method: 'GET',
    url: '/api/chat/conversations',
    headers: { cookie: user.cookie },
  });
}

beforeAll(async () => {
  app = await buildApp({ config: loadConfig(), logger: false });
  await app.ready();
});

afterAll(async () => {
  // Conversations first: deleting one cascades its members and messages, which
  // clears the FK references that would otherwise block account deletion.
  if (conversations.length) {
    await prisma.conversation
      .deleteMany({ where: { id: { in: conversations } } })
      .catch(() => undefined);
  }
  for (const user of users) {
    await destroyTestUser(user).catch(() => undefined);
  }
  // Roles last: the accounts holding them are gone, so the FK no longer bites.
  if (testRoles.length) {
    await prisma.appRole.deleteMany({ where: { key: { in: testRoles } } }).catch(() => undefined);
  }
  await app.close();
  await prisma.$disconnect();
});

describe('chat (Phase 17, step 1)', () => {
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let nobody: TestUser;

  beforeAll(async () => {
    alice = await makeUser(['administrator']);
    bob = await makeUser(['administrator']);
    carol = await makeUser(['administrator']);
    // Holds a role, but a role with no chat grant: this one exercises the
    // permission gate rather than membership.
    nobody = await makeUser([await makeRoleWithoutChat()]);
  });

  it('opens a direct conversation, and re-opening returns the same thread', async () => {
    const first = await openDm(alice, bob.id);
    const second = await openDm(alice, bob.id);
    expect(second).toBe(first);

    const response = await listConversations(alice);
    expect(response.statusCode).toBe(200);
    const conversation = response.json().conversations.find((c: { id: number }) => c.id === first);
    expect(conversation).toBeDefined();
    expect(conversation.kind).toBe('DM');
    expect(conversation.peer.id).toBe(bob.id);
    expect(conversation.unreadCount).toBe(0);
  });

  it('counts a message unread for the recipient until they mark it read', async () => {
    const dm = await openDm(alice, bob.id);

    const sent = await send(alice, dm, { body: 'Morning Bob' });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().message.body).toBe('Morning Bob');
    expect(sent.json().message.senderId).toBe(alice.id);

    const history = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${dm}/messages`,
      headers: { cookie: bob.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().messages.map((m: { body: string }) => m.body)).toEqual(['Morning Bob']);

    const beforeRead = await listConversations(bob);
    expect(
      beforeRead.json().conversations.find((c: { id: number }) => c.id === dm).unreadCount,
    ).toBe(1);

    const read = await app.inject({
      method: 'POST',
      url: `/api/chat/conversations/${dm}/read`,
      headers: { cookie: bob.cookie },
    });
    expect(read.statusCode).toBe(200);

    const afterRead = await listConversations(bob);
    expect(
      afterRead.json().conversations.find((c: { id: number }) => c.id === dm).unreadCount,
    ).toBe(0);
  });

  it('treats a repeated client token as the same message', async () => {
    const dm = await openDm(alice, bob.id);
    const clientToken = randomUUID();

    const first = await send(alice, dm, { body: 'once', clientToken });
    const second = await send(alice, dm, { body: 'once', clientToken });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().message.id).toBe(first.json().message.id);
  });

  it('hides a conversation from a non-member behind a 404', async () => {
    const dm = await openDm(alice, bob.id);

    const read = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${dm}/messages`,
      headers: { cookie: carol.cookie },
    });
    expect(read.statusCode).toBe(404);

    const write = await send(carol, dm, { body: 'let me in' });
    expect(write.statusCode).toBe(404);

    const list = await listConversations(carol);
    expect(list.json().conversations.some((c: { id: number }) => c.id === dm)).toBe(false);
  });

  it('refuses a conversation with yourself, and one with an unknown account', async () => {
    const self = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations',
      headers: { cookie: alice.cookie },
      payload: { userId: alice.id },
    });
    expect(self.statusCode).toBe(422);
    expect(self.json().error).toBe('CHAT_SELF');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/chat/conversations',
      headers: { cookie: alice.cookie },
      payload: { userId: 99_999_999 },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toBe('CHAT_USER_NOT_FOUND');
  });

  it('rejects an empty message', async () => {
    const dm = await openDm(alice, bob.id);
    const response = await send(alice, dm, { body: '   ' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('VALIDATION_FAILED');
  });

  it('lists accounts you can message, excluding yourself', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/chat/users',
      headers: { cookie: alice.cookie },
    });
    expect(response.statusCode).toBe(200);
    const ids = response.json().users.map((u: { id: number }) => u.id);
    expect(ids).toContain(bob.id);
    expect(ids).not.toContain(alice.id);
  });

  it('pages history by keyset, oldest-first within a page', async () => {
    const dm = await openDm(carol, alice.id);
    for (const body of ['one', 'two', 'three']) {
      const response = await send(carol, dm, { body });
      expect(response.statusCode).toBe(201);
    }

    const page1 = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${dm}/messages?limit=2`,
      headers: { cookie: carol.cookie },
    });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().messages.map((m: { body: string }) => m.body)).toEqual(['two', 'three']);

    const oldestHeld = page1.json().messages[0].id as number;
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/chat/conversations/${dm}/messages?limit=2&before=${oldestHeld}`,
      headers: { cookie: carol.cookie },
    });
    expect(page2.json().messages.map((m: { body: string }) => m.body)).toEqual(['one']);
  });

  it('refuses chat without the permission', async () => {
    const response = await listConversations(nobody);
    expect(response.statusCode).toBe(403);
  });
});
