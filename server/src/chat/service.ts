/**
 * Chat service (Phase 17): direct conversations, their messages, read state,
 * images and search.
 *
 * ## Membership is the boundary
 *
 * There is no "read everyone's messages" permission. Every read and write goes
 * through {@link assertMember}, so a conversation id that was guessed or leaked
 * resolves to nothing for a non-member — a 404, not a 403, because the row does
 * not exist *for them*. That also means a probe cannot tell a real conversation
 * id from an imaginary one.
 *
 * ## Direct conversations dedupe
 *
 * A DM is keyed by the two account ids sorted ("min:max") and that key is
 * unique, so two people clicking "message" at the same moment land in one thread
 * rather than two. The unique index is the guarantee; the lookup is the fast
 * path.
 *
 * ## Unread is derived, never stored
 *
 * A member's unread count is messages from someone else newer than their
 * `lastReadAt`. Nothing is written when a message arrives, so there is no counter
 * to drift. It costs one cheap indexed count per conversation.
 */
import { HttpError } from '../auth/plugin.js';
import type { Principal } from '../auth/principal.js';
import { prisma } from '../db/client.js';
import { Prisma } from '../generated/prisma/client.js';

const USER_SELECT = {
  id: true,
  employeeId: true,
  email: true,
  isActive: true,
  avatarUpdatedAt: true,
  employee: { select: { name: true, surname: true } },
} satisfies Prisma.AppUserSelect;

const MESSAGE_SELECT = {
  id: true,
  conversationId: true,
  senderId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  sender: { select: { employee: { select: { name: true, surname: true } } } },
  attachment: {
    select: {
      id: true,
      mime: true,
      width: true,
      height: true,
      sizeBytes: true,
      originalName: true,
    },
  },
} satisfies Prisma.MessageSelect;

/**
 * A message plus enough of its conversation to name the other person, for search
 * results. Separate from `MESSAGE_SELECT` so history does not pay for the join.
 */
const SEARCH_MESSAGE_SELECT = {
  ...MESSAGE_SELECT,
  conversation: {
    select: {
      id: true,
      members: { select: { userId: true, user: { select: USER_SELECT } } },
    },
  },
} satisfies Prisma.MessageSelect;

const CONVERSATION_SELECT = {
  id: true,
  kind: true,
  lastMessageAt: true,
  members: {
    select: {
      userId: true,
      lastReadAt: true,
      user: { select: USER_SELECT },
    },
  },
  messages: {
    orderBy: { id: 'desc' as const },
    take: 1,
    select: MESSAGE_SELECT,
  },
} satisfies Prisma.ConversationSelect;

type UserRow = Prisma.AppUserGetPayload<{ select: typeof USER_SELECT }>;
type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;
type ConversationRow = Prisma.ConversationGetPayload<{ select: typeof CONVERSATION_SELECT }>;

export interface ChatUserView {
  id: number;
  employeeId: number;
  name: string;
  email: string;
  isActive: boolean;
  avatarUpdatedAt: string | null;
}

/** An image on a message, as the client needs it. The bytes are fetched by id. */
export interface ChatAttachmentView {
  id: number;
  mime: string;
  width: number;
  height: number;
  sizeBytes: number;
  originalName: string | null;
}

export interface ChatMessageView {
  id: number;
  conversationId: number;
  senderId: number;
  senderName: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  /** The image sent with the message, if any. `null` for a text-only message. */
  attachment: ChatAttachmentView | null;
}

export interface ChatConversationView {
  id: number;
  kind: string;
  /** The other member. In step 1 every conversation is a direct one. */
  peer: ChatUserView;
  lastMessage: ChatMessageView | null;
  lastMessageAt: string | null;
  lastReadAt: string | null;
  /** The peer's read watermark, so the sender can show a "Seen" marker. */
  peerLastReadAt: string | null;
  unreadCount: number;
}

function toUserView(row: UserRow): ChatUserView {
  return {
    id: row.id,
    employeeId: row.employeeId,
    name: `${row.employee.name} ${row.employee.surname}`.trim(),
    email: row.email,
    isActive: row.isActive,
    avatarUpdatedAt: row.avatarUpdatedAt?.toISOString() ?? null,
  };
}

function toMessageView(row: MessageRow): ChatMessageView {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    senderName: `${row.sender.employee.name} ${row.sender.employee.surname}`.trim(),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    attachment: row.attachment
      ? {
          id: row.attachment.id,
          mime: row.attachment.mime,
          width: row.attachment.width,
          height: row.attachment.height,
          sizeBytes: row.attachment.sizeBytes,
          originalName: row.attachment.originalName,
        }
      : null,
  };
}

/**
 * Loads the caller's membership of a conversation, or 404s.
 *
 * The 404 (not 403) is deliberate: a non-member should not be able to learn that
 * a conversation id exists.
 */
export async function assertMember(conversationId: number, userId: number) {
  const member = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!member) {
    throw new HttpError(404, 'CONVERSATION_NOT_FOUND', `Conversation ${conversationId} not found.`);
  }
  return member;
}

/**
 * The account ids that make up a conversation, for fanning an event out. Kept in
 * the service so the routes never reach for `prisma` themselves.
 */
export async function conversationMemberIds(conversationId: number): Promise<number[]> {
  const rows = await prisma.conversationMember.findMany({
    where: { conversationId },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/** Account directory: everyone active except the caller. */
export async function listChatUsers(principal: Principal): Promise<ChatUserView[]> {
  const rows = await prisma.appUser.findMany({
    where: { isActive: true, id: { not: principal.userId } },
    orderBy: [{ employee: { surname: 'asc' } }, { employee: { name: 'asc' } }],
    select: USER_SELECT,
  });
  return rows.map(toUserView);
}

async function toConversationView(
  row: ConversationRow,
  viewerId: number,
): Promise<ChatConversationView> {
  const me = row.members.find((member) => member.userId === viewerId);
  const peer = row.members.find((member) => member.userId !== viewerId);
  if (!peer) {
    // A direct conversation always has exactly two members. Reaching here means
    // the data is wrong, not the request.
    throw new HttpError(
      500,
      'CHAT_NOT_DIRECT',
      'Direct conversation does not have a second member.',
    );
  }

  const unreadCount = await prisma.message.count({
    where: {
      conversationId: row.id,
      senderId: { not: viewerId },
      deletedAt: null,
      ...(me?.lastReadAt ? { createdAt: { gt: me.lastReadAt } } : {}),
    },
  });

  const last = row.messages[0];
  return {
    id: row.id,
    kind: row.kind,
    peer: toUserView(peer.user),
    lastMessage: last ? toMessageView(last) : null,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastReadAt: me?.lastReadAt?.toISOString() ?? null,
    peerLastReadAt: peer.lastReadAt?.toISOString() ?? null,
    unreadCount,
  };
}

/** The caller's conversations, newest activity first. */
export async function listConversations(principal: Principal): Promise<ChatConversationView[]> {
  const rows = await prisma.conversation.findMany({
    where: { members: { some: { userId: principal.userId } } },
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
    select: CONVERSATION_SELECT,
  });
  return Promise.all(rows.map((row) => toConversationView(row, principal.userId)));
}

/** Opens the direct conversation with `otherUserId`, creating it if needed. */
export async function openDirectConversation(
  principal: Principal,
  otherUserId: number,
): Promise<ChatConversationView> {
  if (otherUserId === principal.userId) {
    throw new HttpError(422, 'CHAT_SELF', 'You cannot start a conversation with yourself.');
  }

  const target = await prisma.appUser.findUnique({
    where: { id: otherUserId },
    select: { id: true, isActive: true },
  });
  if (!target || !target.isActive) {
    throw new HttpError(404, 'CHAT_USER_NOT_FOUND', `Account ${otherUserId} is not available.`);
  }

  const dmKey = [principal.userId, otherUserId].sort((a, b) => a - b).join(':');
  const row = await prisma.conversation.upsert({
    where: { dmKey },
    create: {
      kind: 'DM',
      dmKey,
      members: { create: [{ userId: principal.userId }, { userId: otherUserId }] },
    },
    update: {},
    select: CONVERSATION_SELECT,
  });
  return toConversationView(row, principal.userId);
}

/**
 * A page of history, oldest-first for painting.
 *
 * `before` is the oldest id the client already holds, so paging back is a
 * keyset walk on the primary key — stable while new messages arrive, which an
 * offset would not be.
 */
export async function listMessages(
  principal: Principal,
  conversationId: number,
  options: { before?: number; limit?: number },
): Promise<ChatMessageView[]> {
  await assertMember(conversationId, principal.userId);
  const take = Math.min(options.limit ?? 50, 100);
  const rows = await prisma.message.findMany({
    where: { conversationId, ...(options.before ? { id: { lt: options.before } } : {}) },
    orderBy: { id: 'desc' },
    take,
    select: MESSAGE_SELECT,
  });

  // Newest-first from the database so keyset paging walks backwards, but painted
  // oldest-first. Walked in reverse explicitly rather than with `Array#reverse`,
  // which mutates in place and the linter forbids.
  const ordered: ChatMessageView[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    ordered.push(toMessageView(rows[index]!));
  }
  return ordered;
}

/** Posts a message and moves the conversation to the top of both lists. */
export async function sendMessage(
  principal: Principal,
  conversationId: number,
  input: { body: string; clientToken?: string },
): Promise<ChatMessageView> {
  await assertMember(conversationId, principal.userId);

  // A retried send carries the same token; return the original rather than
  // posting a duplicate.
  if (input.clientToken) {
    const existing = await prisma.message.findUnique({
      where: {
        conversationId_clientToken: { conversationId, clientToken: input.clientToken },
      },
      select: MESSAGE_SELECT,
    });
    if (existing) return toMessageView(existing);
  }

  const created = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: principal.userId,
        body: input.body,
        clientToken: input.clientToken ?? null,
      },
      select: MESSAGE_SELECT,
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  });

  return toMessageView(created);
}

/** Marks everything up to now read for the caller. */
export async function markRead(
  principal: Principal,
  conversationId: number,
): Promise<{ lastReadAt: string }> {
  await assertMember(conversationId, principal.userId);
  const lastReadAt = new Date();
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId: principal.userId } },
    data: { lastReadAt },
  });
  return { lastReadAt: lastReadAt.toISOString() };
}

/**
 * Posts a message carrying an already-processed image.
 *
 * The body may be empty (an image on its own is a complete message); the route
 * allows that, while the text-only send still requires words. The bytes arrive
 * here having been decoded and re-encoded by `sharp` in the route, so the service
 * stores a bounded WebP rather than whatever the browser uploaded.
 */
export async function createAttachmentMessage(
  principal: Principal,
  conversationId: number,
  input: {
    body: string;
    bytes: Uint8Array;
    mime: string;
    originalName: string | null;
    width: number;
    height: number;
  },
): Promise<ChatMessageView> {
  await assertMember(conversationId, principal.userId);

  const created = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId,
        senderId: principal.userId,
        body: input.body,
        attachment: {
          create: {
            bytes: new Uint8Array(input.bytes),
            mime: input.mime,
            originalName: input.originalName,
            width: input.width,
            height: input.height,
            sizeBytes: input.bytes.byteLength,
          },
        },
      },
      select: MESSAGE_SELECT,
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: message.createdAt },
    });
    return message;
  });

  return toMessageView(created);
}

/**
 * The bytes for one attachment, or a 404 for a non-member.
 *
 * Membership rides on the message's conversation, so a guessed attachment id is
 * as opaque as a guessed conversation id: the same 404, and no way to tell a real
 * attachment from an imaginary one.
 */
export async function getAttachment(
  principal: Principal,
  attachmentId: number,
): Promise<{ bytes: Buffer; mime: string }> {
  const attachment = await prisma.messageAttachment.findUnique({
    where: { id: attachmentId },
    select: { bytes: true, mime: true, message: { select: { conversationId: true } } },
  });
  if (!attachment) {
    throw new HttpError(404, 'ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found.`);
  }
  await assertMember(attachment.message.conversationId, principal.userId);
  return { bytes: Buffer.from(attachment.bytes), mime: attachment.mime };
}

export interface ChatSearchResult {
  conversationId: number;
  /** The other member, so a result reads as a conversation, not a bare message. */
  peer: ChatUserView;
  message: ChatMessageView;
}

/**
 * Message search across the conversations the caller belongs to.
 *
 * `contains` with `mode: 'insensitive'` is Postgres `ILIKE '%term%'`. There is no
 * index that helps a leading-wildcard match, which is the honest trade at this
 * size: full-text `tsvector` ranks better but needs a column, a trigger and a
 * migration. Membership is the boundary here too, so a search can only ever reach
 * threads the caller is already in.
 */
export async function searchMessages(
  principal: Principal,
  term: string,
  limit = 20,
): Promise<ChatSearchResult[]> {
  const rows = await prisma.message.findMany({
    where: {
      deletedAt: null,
      body: { contains: term, mode: 'insensitive' },
      conversation: { members: { some: { userId: principal.userId } } },
    },
    orderBy: { id: 'desc' },
    take: Math.min(limit, 50),
    select: SEARCH_MESSAGE_SELECT,
  });

  const results: ChatSearchResult[] = [];
  for (const row of rows) {
    const peer = row.conversation.members.find((member) => member.userId !== principal.userId);
    if (!peer) continue;
    results.push({
      conversationId: row.conversation.id,
      peer: toUserView(peer.user),
      message: toMessageView(row),
    });
  }
  return results;
}
