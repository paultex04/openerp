/**
 * Chat API (Phase 17).
 *
 * RBAC map:
 *   chat.read    list conversations, read history, mark read, the account
 *                directory you may open a conversation with, the live stream,
 *                download an image, search
 *   chat.write   open a conversation, send a message, signal typing, upload an
 *                image, delete a conversation
 *
 * Membership is enforced in the service, not here, because it depends on the row
 * rather than the endpoint — and a non-member gets a 404, not a 403, so a
 * guessed conversation id reveals nothing.
 *
 * Step 1 was request/response only. Step 2 added the live channel, step 3 images
 * and search, and a follow-up added deletion:
 *
 *   GET    /api/chat/stream                        server-sent events (SSE)
 *   POST   /api/chat/conversations/:id/typing      ephemeral typing signal
 *   POST   /api/chat/conversations/:id/attachments send an image
 *   GET    /api/chat/attachments/:id               fetch an image's bytes
 *   GET    /api/chat/search                        message search
 *   DELETE /api/chat/conversations/:id             delete the whole conversation
 *
 * Message, read and deleted events are published from here, *after* the service
 * call, so the service stays transport-agnostic. Polling is kept in the client as
 * the fallback: a dropped stream costs latency, never data.
 */
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_DIMENSION,
  CHAT_MESSAGE_MAX,
  chatConversationOpenSchema,
  chatMessageCreateSchema,
  chatMessageListQuerySchema,
  chatSearchQuerySchema,
  chatTypingSchema,
} from '@openerp/shared';
import { HttpError } from '../auth/plugin.js';
import type { Config } from '../config.js';
import { fileTooLarge } from './profile.js';
import {
  assertMember,
  conversationMemberIds,
  createAttachmentMessage,
  deleteConversation,
  getAttachment,
  listChatUsers,
  listConversations,
  listMessages,
  markRead,
  openDirectConversation,
  searchMessages,
  sendMessage,
} from '../chat/service.js';
import { onlineUserIds, publishTo, subscribe } from '../chat/events.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

/** WebP quality for a stored chat image. Visually lossless enough at this cap. */
const CHAT_IMAGE_QUALITY = 82;

/** A comment frame keeps the connection alive through proxies during quiet spells. */
const SSE_HEARTBEAT_MS = 25_000;

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function registerChatRoutes(app: FastifyInstance, config: Config): Promise<void> {
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
   * Deletes the whole conversation, for both members.
   *
   * Destructive and final, so the client asks first; the server simply does it for
   * a member. The other member's open stream is told to drop the row, because
   * waiting for their next poll would leave a conversation they can no longer open
   * sitting in their list.
   */
  app.delete(
    '/api/chat/conversations/:id',
    { preHandler: [app.authenticate, app.requirePermission('chat.write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { memberIds } = await deleteConversation(request.principal!, id);
      publishTo(memberIds, { type: 'deleted', conversationId: id });
      return reply.code(204).send();
    },
  );

  /**
   * Sends an image, with an optional caption. Multipart: the file in the "file"
   * field, the caption in "body".
   *
   * The image is decoded and re-encoded by `sharp` before it is stored, exactly
   * as the avatar is: orientation applied, scaled to fit a bounded box, WebP. So
   * the database never holds an arbitrary upload. A file that will not decode is
   * a 400, not a stored broken row.
   */
  app.post(
    '/api/chat/conversations/:id/attachments',
    {
      preHandler: [app.authenticate, app.requirePermission('chat.write')],
      // Image processing is the costly part, so it is capped per account, like
      // the avatar upload. Skipped under test for the same reason.
      config: config.isTest ? {} : { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // Membership first: a non-member must not make the server decode a 5 MB
      // image before it 404s.
      await assertMember(id, request.principal!.userId);

      if (!request.isMultipart()) {
        throw new HttpError(
          400,
          'ATTACHMENT_REQUIRED',
          'Send the image as multipart form data with a "file" field.',
        );
      }

      let source: Buffer | null = null;
      let originalName: string | null = null;
      let caption = '';
      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (source) continue; // one image per message (multipart `files: 1`)
            originalName = part.filename ?? null;
            source = await part.toBuffer();
          } else if (part.fieldname === 'body' && typeof part.value === 'string') {
            caption = part.value;
          }
        }
      } catch (error) {
        if (fileTooLarge(error)) {
          throw new HttpError(
            413,
            'ATTACHMENT_TOO_LARGE',
            `Images must be ${Math.floor(
              CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024),
            )} MB or smaller.`,
          );
        }
        throw error;
      }

      if (!source) {
        throw new HttpError(400, 'ATTACHMENT_REQUIRED', 'No image was attached.');
      }
      const body = caption.trim();
      if (body.length > CHAT_MESSAGE_MAX) {
        throw new HttpError(
          400,
          'VALIDATION_FAILED',
          `The caption is longer than ${CHAT_MESSAGE_MAX} characters.`,
        );
      }

      let processed: Buffer;
      let width: number;
      let height: number;
      try {
        const result = await sharp(source)
          // EXIF orientation first, or a sideways photo stays sideways.
          .rotate()
          .resize({
            width: CHAT_ATTACHMENT_MAX_DIMENSION,
            height: CHAT_ATTACHMENT_MAX_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: CHAT_IMAGE_QUALITY })
          .toBuffer({ resolveWithObject: true });
        processed = result.data;
        width = result.info.width;
        height = result.info.height;
      } catch {
        throw new HttpError(
          400,
          'ATTACHMENT_UNREADABLE',
          'That file could not be read as an image. Send a PNG, JPEG or WebP.',
        );
      }

      const message = await createAttachmentMessage(request.principal!, id, {
        body,
        bytes: processed,
        mime: 'image/webp',
        originalName,
        width,
        height,
      });
      publishTo(await conversationMemberIds(id), { type: 'message', conversationId: id, message });
      return reply.code(201).send({ message });
    },
  );

  /** The bytes for an attachment. Membership is checked against its conversation. */
  app.get(
    '/api/chat/attachments/:id',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const attachment = await getAttachment(request.principal!, id);
      return (
        reply
          .header('content-type', attachment.mime)
          // The bytes never change under an id, so a private immutable cache is safe
          // and the thread does not refetch images on every render.
          .header('cache-control', 'private, max-age=31536000, immutable')
          .send(attachment.bytes)
      );
    },
  );

  /**
   * Message search across the conversations the caller belongs to. Membership is
   * the boundary, so a search can only reach threads the caller is already in.
   */
  app.get(
    '/api/chat/search',
    { preHandler: [app.authenticate, app.requirePermission('chat.read')] },
    async (request) => {
      const query = chatSearchQuerySchema.parse(request.query ?? {});
      return { results: await searchMessages(request.principal!, query.q, query.limit) };
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
