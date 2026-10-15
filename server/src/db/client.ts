/**
 * Prisma client with zero-miss write auditing.
 *
 * Every `create`, `update`, `delete`, `createMany`, `updateMany` and `deleteMany`
 * performed anywhere in the application is recorded. The alternative — calling an
 * `audit()` helper inside each service function — was rejected because an audit
 * trail that depends on every future author remembering is an audit trail with
 * gaps, and the gaps are always where it matters.
 *
 * ## How the actor is known
 *
 * The extension reads `AsyncLocalStorage` (see `audit/context.ts`), which the
 * authentication hook populates per request. So the write layer needs no actor
 * parameter, and a service function cannot forget to pass one.
 *
 * ## Before/after capture
 *
 * UPDATE and DELETE read the affected row first. That is one extra indexed read
 * per write, in exchange for an entry that says what the value *was*. An audit
 * log that only records the new state cannot answer "who changed the rate from
 * 17.5226 to 20", which is the question it exists to answer.
 *
 * On UPDATE only the fields that actually differ are written to `after` and listed
 * in `changed_fields`, so a reviewer sees the edit rather than the entire row.
 *
 * ## Failure policy
 *
 * An audit failure is logged and swallowed: it must not roll back or fail the
 * business operation. This is a deliberate trade — availability over
 * completeness — so `auditFailures` counts them and the health endpoint surfaces
 * it. Silent loss would be worse; a counted, logged, monitored loss is not.
 *
 * ## Recursion
 *
 * Entries are written through the *base* client, never the extended one, so an
 * audit insert cannot trigger another audit insert. The explicit model guard is
 * belt and braces against a future refactor reaching for the extended client.
 */
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { currentAuditActor, SYSTEM_ACTOR, type AuditActor } from '../audit/context.js';
import { recordWrite, type WriteAuditEntry } from '../audit/service.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '') {
  // Fail at import rather than at the first query. `pg` treats a missing
  // connection string as `postgres://<os-user>@localhost:5432`, so the symptom
  // would otherwise be a confusing "Can't reach database server at localhost"
  // from a background probe, with no hint that the real problem is a `.env` that
  // never loaded.
  throw new Error('DATABASE_URL is not set; refusing to fall back to the local Postgres defaults');
}

/**
 * The connection.
 *
 * Prisma 7 is Rust-free: there is no query engine, and the client talks to
 * Postgres through a driver adapter instead. `PrismaPg` wraps `pg`, which this
 * repository already depends on for the migration runner.
 *
 * The pool settings are pinned to the five-second connect timeout the Rust-era
 * Prisma engines used, rather than left to `pg`'s default, because `pg` waits
 * forever where the old engine gave up after five seconds. Without this, a
 * database that accepts the socket and then never answers would hang the
 * readiness probe instead of failing it.
 */
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

const base =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = base;

/**
 * Shape of a query-extension callback's arguments.
 *
 * Prisma 7 no longer infers these for a `$allModels` hook: the hook is applied to
 * every model at once, so `args` is the union of all models' argument types and
 * TypeScript cannot narrow `model`, `args` or `query` without help. Declaring the
 * contract here keeps `noImplicitAny` satisfied and, more usefully, names the one
 * thing this file actually relies on: `query(args)` returns the row.
 */
type WriteQueryArgs = {
  model: string;
  args: { where?: Record<string, unknown>; data?: unknown };
  query: (args: unknown) => Promise<unknown>;
};

export const prisma = base.$extends({
  name: 'audit',
  query: {
    $allModels: {
      async create({ model, args, query }: WriteQueryArgs) {
        // Captured synchronously, before the query runs. Reading the actor after
        // the await would pick up whichever request happens to be in flight by
        // then — the audit entry would name the wrong user, which is worse than
        // having no entry at all because it looks trustworthy.
        const actor = captureActor();
        const result = await query(args);
        void write(model, 'CREATE', result, undefined, args, actor);
        return result;
      },
      async createMany({ model, args, query }: WriteQueryArgs) {
        const actor = captureActor();
        const result = (await query(args)) as { count: number };
        void write(model, 'CREATE', { count: result.count }, undefined, args, actor);
        return result;
      },
      async update({ model, args, query }: WriteQueryArgs) {
        const actor = captureActor();
        const before = await readBefore(model, args);
        const result = await query(args);
        // Prisma returns the whole updated row, but an audit entry must record
        // the *change*. Storing the full row would duplicate the table into the
        // log and bury the one field a reviewer cares about, so `after` is
        // narrowed to the keys that actually differ.
        void write(model, 'UPDATE', result, before, args, actor);
        return result;
      },
      async updateMany({ model, args, query }: WriteQueryArgs) {
        const actor = captureActor();
        const before = await readBefore(model, args);
        const result = (await query(args)) as { count: number };
        void write(
          model,
          'UPDATE',
          { ...(args.data as Record<string, unknown>), count: result.count },
          before,
          args,
          actor,
        );
        return result;
      },
      async delete({ model, args, query }: WriteQueryArgs) {
        const actor = captureActor();
        const before = await readBefore(model, args);
        const result = await query(args);
        void write(model, 'DELETE', undefined, before, args, actor);
        return result;
      },
      async deleteMany({ model, args, query }: WriteQueryArgs) {
        const actor = captureActor();
        const before = await readBefore(model, args);
        const result = await query(args);
        void write(model, 'DELETE', undefined, before, args, actor);
        return result;
      },
    },
  },
});

/** The actor bound to the current async context, or the system marker. */
function captureActor(): AuditActor {
  return currentAuditActor() ?? SYSTEM_ACTOR;
}

/** Audit writes must never themselves be audited. */
function isAuditable(model: string): boolean {
  return model !== 'AuditLog';
}

async function write(
  model: string,
  action: WriteAuditEntry['action'],
  after: unknown,
  before: unknown,
  args: unknown,
  actor: AuditActor,
): Promise<void> {
  if (!isAuditable(model)) return;

  const cleanBefore = sanitise(before);
  const cleanAfter = sanitise(after);
  const changedFields = changedFieldsOf(cleanBefore, cleanAfter);

  const entry: WriteAuditEntry = {
    action,
    model,
    after: action === 'UPDATE' ? narrowToChanged(cleanAfter, changedFields) : cleanAfter,
    before: cleanBefore,
    changedFields,
    recordId: recordIdOf(after, before, args),
  };

  await recordWrite(entry, actor);
}

/**
 * Reads the rows an update or delete is about to touch.
 *
 * Best-effort by design: if the read fails (a `where` Prisma cannot express as a
 * unique read) the write still proceeds and the entry simply has no `before`
 * state. Failing the business operation because its audit could not read a row
 * would be the wrong trade.
 */
async function readBefore(
  model: string,
  args: { where?: Record<string, unknown> },
): Promise<unknown> {
  if (!isAuditable(model) || !args?.where) return undefined;

  try {
    const delegate = (
      base as unknown as Record<string, { findFirst?: (a: unknown) => Promise<unknown> }>
    )[model];
    if (typeof delegate?.findFirst !== 'function') return undefined;
    return await delegate.findFirst({ where: args.where });
  } catch {
    return undefined;
  }
}

/** Keys whose values differ between the two row states. */
function changedFieldsOf(before: unknown, after: unknown): string[] | undefined {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object')
    return undefined;

  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const changed: string[] = [];

  for (const key of Object.keys(a)) {
    if (key === 'updatedAt') continue; // noise: changes on every write
    if (key === 'count') continue; // bulk-operation metadata, not a field
    if (!Object.is(b[key], a[key])) changed.push(key);
  }

  return changed.length > 0 ? changed : undefined;
}

/**
 * Keeps only the named keys.
 *
 * Prisma returns the whole updated row, but an audit entry has to record the
 * *change*: storing the full row would duplicate the table into the log and bury
 * the one field a reviewer came for.
 */
function narrowToChanged(
  after: Record<string, unknown> | undefined,
  changedFields: string[] | undefined,
): Record<string, unknown> | undefined {
  if (!after) return undefined;
  // No comparable `before` (a bulk write, say): keep what we were given.
  if (!changedFields) return after;

  const narrowed: Record<string, unknown> = {};
  for (const key of changedFields) {
    if (key in after) narrowed[key] = after[key];
  }
  return narrowed;
}

/**
 * The affected row's identifier.
 *
 * Prefers the returned row, falls back to the `where` clause, and for a bulk
 * write there is no single id so the count is reported in the summary instead.
 */
function recordIdOf(after: unknown, before: unknown, args: unknown): string | undefined {
  const row = (after ?? before) as Record<string, unknown> | undefined;
  if (row && typeof row === 'object' && 'id' in row && row.id !== undefined) {
    return String(row.id);
  }

  const where = (args as { where?: Record<string, unknown> } | undefined)?.where;
  if (where && typeof where === 'object' && where.id !== undefined) return String(where.id);

  return undefined;
}

/**
 * Prepares a row for the JSONB column.
 *
 * Dates become ISO strings, `BigInt` becomes a string (JSON has no BigInt), and
 * nested relation payloads are dropped: an audit entry records the row's own
 * fields, not a copy of its relations, which would duplicate the data being
 * audited and bloat the log without adding information.
 */
function sanitise(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return { value };

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    if (v === undefined) continue;
    if (v instanceof Date) {
      out[key] = v.toISOString();
    } else if (typeof v === 'bigint') {
      out[key] = v.toString();
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // A nested object is either a Decimal, an included relation, or a JSON
      // column. Decimal is detected by its class name because it has no reliable
      // own-property signature; an included relation is recognised by having an
      // `id` and is dropped, because recording a copy of a relation would
      // duplicate the very data being audited.
      if (isDecimal(v)) {
        out[key] = String(v);
      } else if (looksLikeRelation(v)) {
        continue;
      } else {
        out[key] = v;
      }
    } else {
      out[key] = v;
    }
  }

  return out;
}

/** A nested object with an `id` is a relation that was `include`d. */
function looksLikeRelation(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'id' in value;
}

/** Prisma's Decimal wrapper, identified by its class name. */
function isDecimal(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { constructor?: { name?: string } }).constructor?.name === 'Decimal'
  );
}

export { base as prismaBase };
export async function disconnectPrisma(): Promise<void> {
  await base.$disconnect();
}
