/**
 * Chat API (Phase 17, step 1).
 *
 * RBAC map:
 *   chat.read    list conversations, read history, mark read, the account
 *                directory you may open a conversation with
 *   chat.write   open a conversation and send a message
 *
 * Membership is enforced in the service, not here, because it depends on the row
 * rather than the endpoint — and a non-member gets a 404, not a 403, so a
 * guessed conversation id reveals nothing.
 *
 * Step 1 is request/response only. Live delivery (SSE), typing/presence,
 * attachments and search are later steps and add endpoints alongside these.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  chatConversationOpenSchema,
  chatMessageCreateSchema,
  chatMessageListQuerySchema,
} from '@openerp/shared';
import {
  listChatUsers,
  listConversations,
  listMessages,
  markRead,
  openDirectConversation,
  sendMessage,
} from '../chat/service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

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
      return reply.code(201).send({ message });
    },
  );

  app.post(
    '/api/chat/conversations/:id/read',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return markRead(request.principal!, id);
    },
  );
}
