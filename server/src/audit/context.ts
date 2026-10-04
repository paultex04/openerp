/**
 * Request-scoped actor context for the audit log.
 *
 * The audit trail has to answer "who did this", but the Prisma layer that
 * observes writes knows nothing about HTTP. `AsyncLocalStorage` carries the actor
 * from the authentication hook down to the query extension without threading a
 * parameter through every service function — which is the difference between an
 * audit trail that is complete and one that is forgotten at a call site.
 *
 * Anything running outside a request (the seed, a script, a test) sees no actor
 * and is recorded as `system`, which is honest rather than absent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface AuditActor {
  userId: number | null;
  email: string | null;
  employeeId: number | null;
  /** Fastify request id, for tracing a specific call. */
  requestId: string | null;
  route: string | null;
  method: string | null;
}

const storage = new AsyncLocalStorage<AuditActor>();

/** Runs `fn` with `actor` as the current audit actor. */
export function withAuditActor<T>(actor: AuditActor, fn: () => T): T {
  return storage.run(actor, fn);
}

/**
 * Binds `actor` to the current async context without wrapping a callback.
 *
 * Needed by the authentication preHandler: it sets the actor and then returns,
 * with the request continuing on the same async chain. `run` cannot express that
 * — its scope ends when the callback returns — so `enterWith` is the correct
 * primitive even though it is the one to reach for carefully. It is confined to
 * this single call site, and only ever with an authenticated principal.
 *
 * ## The caveat this creates
 *
 * `enterWith` binds for the remainder of the current async execution context. In
 * the server that context is one HTTP request, so the binding dies with the
 * request and nothing leaks between callers.
 *
 * It is *not* true of code that continues on the same chain after a request has
 * been handled — a test that calls `app.inject()` and then performs a direct
 * database write is exactly that case, and the write would be misattributed to
 * the last authenticated user. `asSystem` exists for those callers: it records
 * the work honestly instead of letting it inherit an unrelated actor.
 */
export function enterAuditActor(actor: AuditActor): void {
  storage.enterWith(actor);
}

/** Runs `fn` with the actor cleared, so its writes are recorded as `system`. */
export function asSystem<T>(fn: () => T): T {
  return storage.run(SYSTEM_ACTOR, fn);
}

/** The current actor, or null outside a request. */
export function currentAuditActor(): AuditActor | null {
  return storage.getStore() ?? null;
}

/**
 * The actor to record when no request context is present.
 *
 * Kept as a distinct marker rather than null so a reader can tell "a script did
 * this" apart from "we lost the actor", which are different problems.
 */
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  email: 'system',
  employeeId: null,
  requestId: null,
  route: null,
  method: null,
};
