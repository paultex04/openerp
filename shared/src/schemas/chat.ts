/**
 * Request/response schemas for internal chat (Phase 17, step 1).
 *
 * Shared so the composer and the API validate identically, like every other
 * `schemas/*` module. Chat here is person-to-person: a conversation is between
 * accounts, and **membership** — not a permission — is what gates a read. The
 * permissions only decide whether an account may use chat at all.
 */
import { z } from 'zod';

/** The longest single message. Long enough for a paragraph, bounded for the DB. */
export const CHAT_MESSAGE_MAX = 4000;

export const chatMessageCreateSchema = z.object({
  body: z.string().trim().min(1, 'Write a message first.').max(CHAT_MESSAGE_MAX),
  /**
   * Optional idempotency key. Two sends carrying the same token return the
   * original message instead of a duplicate — the retry a dropped connection
   * invites.
   */
  clientToken: z.string().trim().min(8).max(64).optional(),
});
export type ChatMessageCreateInput = z.infer<typeof chatMessageCreateSchema>;

/** Open (or re-open) a direct conversation with another account. Idempotent. */
export const chatConversationOpenSchema = z.object({
  userId: z.coerce.number().int().positive(),
});
export type ChatConversationOpenInput = z.infer<typeof chatConversationOpenSchema>;

/**
 * A typing signal. Ephemeral: nothing is stored, it is fanned out to the other
 * members of the conversation and dropped. `isTyping` defaults to true, so a
 * bare post means "I am typing" and `false` is the explicit stop.
 */
export const chatTypingSchema = z.object({
  isTyping: z.boolean().optional(),
});
export type ChatTypingInput = z.infer<typeof chatTypingSchema>;

/** Keyset pagination for a conversation's history. `before` is the oldest id held. */
export const chatMessageListQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
export type ChatMessageListQuery = z.infer<typeof chatMessageListQuerySchema>;
