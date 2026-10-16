/**
 * Chat API (Phase 17).
 *
 * RBAC map:
 *   chat.read    list conversations, read history, mark read, the account
 *                directory you may open a conversation with, the live stream
 *   chat.write   open a conversation, send a message, signal typing
 *
 * Membership is enforced in the service, not here, because it depends on the row
 * rather than the endpoint — and a non-member gets a 404, not a 403, so a
 * guessed conversation id reveals nothing.
 *
 * Step 1 was request/response only. Step 2 adds the live channel alongside it:
 *
 *   GET  /api/chat/stream                     server-sent events (SSE)
 *   POST /api/chat/conversations/:id/typing   ephemeral typing signal
 *
 * Message and read events are published from here, *after* the service call, so
 * the service stays transport-agnostic. Polling is kept in the client as the
 * fallback: a dropped stream costs latency, never data.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  chatConversationOpenSchema,
  chatMessageCreateSchema,
  chatMessageListQuerySchema,
  chatTypingSchema,
} from '@openerp/shared';
import {
  assertMember,
  conversationMemberIds,
  listChatUsers,
  listConversations,
  listMessages,
  markRead,
  openDirectConversation,
  sendMessage,
} from '../chat/service.js';
import { onlineUserIds, publishTo, subscribe } from '../chat/events.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** A comment frame keeps the connection alive through proxies during quiet spells. */
const SSE_HEARTBEAT_MS = 25_000;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/chat/users',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => ({ users: await listChatUsers(request.principal!) }),
  );

  app.get(
    '/api/chat/conversations',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => ({ conversations: await listConversations(request.principal!) }),
  );

  app.post(
    '/api/chat/conversations',
    { preHandler: [app.authenticate, app.requirePermission('chat.write')] },
    async (request, reply) => {
      const body = chatConversationOpenSchema.parse(request.body);
      const conversation = await openDirectConversation(request.principal!, body.userId);
      return reply.code(201).send({ conversation });
    },
  );

  app.get(
    '/api/chat/conversations/:id/messages',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const query = chatMessageListQuerySchema.parse(request.query ?? {});
      return { messages: await listMessages(request.principal!, id, query) };
    },
  );

  app.post(
    '/api/chat/conversations/:id/messages',
    { preHandler: [app.authenticate, app.requirePermission('chat.write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = chatMessageCreateSchema.parse(request.body);
      const message = await sendMessage(request.principal!, id, body);
      publishTo(await conversationMemberIds(id), { type: 'message', conversationId: id, message });
      return reply.code(201).send({ message });
    },
  );

  app.post(
    '/api/chat/conversations/:id/read',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const result = await markRead(request.principal!, id);
      publishTo(await conversationMemberIds(id), {
        type: 'read',
        conversationId: id,
        userId: request.principal!.userId,
        lastReadAt: result.lastReadAt,
      });
      return result;
    },
  );

  /**
   * An ephemeral "I am typing" signal. Membership is asserted (a non-member 404s)
   * and the signal goes to the other members only; nothing is written.
   */
  app.post(
    '/api/chat/conversations/:id/typing',
    { preHandler: [app.authenticate, app.requirePermission('chat.write')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { isTyping } = chatTypingSchema.parse(request.body ?? {});
      const userId = request.principal!.userId;
      await assertMember(id, userId);
      const recipients = (await conversationMemberIds(id)).filter(
        (memberId) => memberId !== userId,
      );
      publishTo(recipients, {
        type: 'typing',
        conversationId: id,
        userId,
        isTyping: isTyping ?? true,
      });
      return { ok: true };
    },
  );

  /**
   * The live channel.
   *
   * Hijacked deliberately: Fastify hands over the socket and the frames are
   * written by hand, which is what SSE needs — a normal handler would try to end
   * the response. The `retry` hint and the immediate `ready` frame mean the
   * browser fires `onopen` and any buffering proxy flushes, rather than sitting
   * on a silent body until the first heartbeat.
   */
  app.get(
    '/api/chat/stream',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request, reply) => {
      const userId = request.principal!.userId;
      reply.hijack();
      const response = reply.raw;

      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Buffering proxies (nginx and Traefik alike) hold the body otherwise.
        'X-Accel-Buffering': 'no',
      });
      response.write('retry: 3000\n\n');
      response.write(sseFrame('ready', { selfId: userId, online: onlineUserIds(userId) }));

      let closed = false;
      const unsubscribe = subscribe(userId, (event) => {
        if (!closed) response.write(sseFrame(event.type, event));
      });
      const heartbeat = setInterval(() => {
        if (!closed) response.write(': keep-alive\n\n');
      }, SSE_HEARTBEAT_MS);

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        response.end();
      };
      request.raw.on('close', close);
      request.raw.on('error', close);
    },
  );
}
