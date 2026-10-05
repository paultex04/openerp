/**
 * Audit log service: recording writes, and reading them back.
 *
 * Recording is deliberately forgiving — an audit failure must never fail the
 * business operation — but not silent: failures are counted and logged so the
 * gap is visible rather than merely absent. See `db/client.ts` for the capture
 * policy.
 */
import { prismaBase } from '../db/client.js';
import type { AuditActor } from './context.js';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface WriteAuditEntry {
  action: AuditAction;
  /** Prisma model name, e.g. `Invoice`. */
  model: string;
  recordId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changedFields?: string[];
}

/** How many audit writes have failed. Surfaced on the health endpoint. */
let auditFailures = 0;

export function auditFailureCount(): number {
  return auditFailures;
}

/** Human-readable labels for the models, so entries read as prose. */
const MODEL_LABELS: Record<string, string> = {
  Invoice: 'invoice',
  InvoiceItem: 'invoice line',
  Job: 'job',
  JobServiceCode: 'job deliverable',
  JobAssignment: 'job crew assignment',
  Project: 'project',
  Contract: 'contract',
  ContractAmendment: 'contract amendment',
  ContractCostParameter: 'cost parameter',
  ServiceCode: 'service code',
  ServiceCodeLabourItem: 'service code labour line',
  ServiceCodeMaterialItem: 'service code material line',
  ServiceMasterRate: 'labour rate card',
  Client: 'client',
  Contact: 'client contact',
  Employee: 'employee',
  Broker: 'labour broker',
  EmployeeContractType: 'employee contract type',
  AppUser: 'user account',
  AppRole: 'role',
};

export function modelLabel(model: string): string {
  return MODEL_LABELS[model] ?? model.toLowerCase().replace(/_/g, ' ');
}

/**
 * Records one write.
 *
 * A no-op when `model` is the audit model itself, which the caller also guards:
 * two independent checks because recursion in an audit hook is the kind of bug
 * that only appears under load.
 */
export async function recordWrite(entry: WriteAuditEntry, actor: AuditActor): Promise<void> {
  if (entry.model === 'AuditLog') return;

  const label = modelLabel(entry.model);
  const subject = entry.recordId ? `${label} #${entry.recordId}` : label;
  const summary = summarise(entry, label, subject);

  try {
    await prismaBase.auditLog.create({
      data: {
        actorUserId: actor.userId,
        actorEmail: actor.email,
        actorEmployeeId: actor.employeeId,
        action: entry.action,
        model: entry.model,
        recordId: entry.recordId ?? null,
        summary,
        before: (entry.before as object | undefined) ?? undefined,
        after:
          entry.action === 'DELETE'
            ? undefined
            : ((entry.after as object | undefined) ?? undefined),
        changedFields: entry.changedFields ?? [],
        requestId: actor.requestId,
        route: actor.route,
        method: actor.method,
      },
    });
  } catch (error) {
    // Counted and logged, never rethrown: losing an audit entry must not fail
    // the write that produced it.
    auditFailures++;
    console.error(
      `[audit] failed to record ${entry.action} on ${entry.model}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function summarise(entry: WriteAuditEntry, label: string, subject: string): string {
  switch (entry.action) {
    case 'CREATE':
      return `Created ${subject}`;
    case 'DELETE':
      return entry.recordId ? `Deleted ${subject}` : `Deleted ${label} rows`;
    case 'UPDATE': {
      const fields = entry.changedFields ?? [];
      if (fields.length === 0) return `Touched ${subject}`;
      if (fields.length <= 3) return `Updated ${subject}: ${fields.join(', ')}`;
      return `Updated ${subject}: ${fields.slice(0, 3).join(', ')} and ${fields.length - 3} more`;
    }
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AuditQuery {
  model?: string;
  actorUserId?: number;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  occurredAt: string;
  actorUserId: number | null;
  actorEmail: string | null;
  action: AuditAction;
  model: string;
  recordId: string | null;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  route: string | null;
  method: string | null;
}

/** Reads the log newest-first. Read-only by construction: no update or delete. */
export async function queryAudit(q: AuditQuery): Promise<{
  entries: AuditRow[];
  total: number;
}> {
  const where = {
    ...(q.model !== undefined && { model: q.model }),
    ...(q.actorUserId !== undefined && { actorUserId: q.actorUserId }),
    ...(q.action !== undefined && { action: q.action }),
    ...(q.from !== undefined || q.to !== undefined
      ? {
          occurredAt: {
            ...(q.from !== undefined && { gte: q.from }),
            ...(q.to !== undefined && { lte: q.to }),
          },
        }
      : {}),
    ...(q.search
      ? {
          OR: [
            { summary: { contains: q.search, mode: 'insensitive' as const } },
            { recordId: { contains: q.search, mode: 'insensitive' as const } },
            { actorEmail: { contains: q.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, count] = await Promise.all([
    prismaBase.auditLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: Math.min(q.limit ?? 100, 500),
      skip: q.offset ?? 0,
    }),
    prismaBase.auditLog.count({ where }),
  ]);

  return {
    entries: rows.map((r) => ({
      id: r.id.toString(),
      occurredAt: r.occurredAt.toISOString(),
      actorUserId: r.actorUserId,
      actorEmail: r.actorEmail,
      action: r.action as AuditAction,
      model: r.model,
      recordId: r.recordId,
      summary: r.summary,
      before: (r.before as Record<string, unknown> | null) ?? null,
      after: (r.after as Record<string, unknown> | null) ?? null,
      changedFields: r.changedFields,
      route: r.route,
      method: r.method,
    })),
    total: count,
  };
}

/** Distinct models present in the log, for the filter dropdown. */
export async function auditModels(): Promise<string[]> {
  const rows = await prismaBase.auditLog.groupBy({ by: ['model'], _count: { _all: true } });
  return rows.sort((a, b) => b._count._all - a._count._all).map((r) => r.model);
}

/** Activity counts by action, for the dashboard tiles. */
export async function auditSummary(
  from?: Date,
  to?: Date,
): Promise<{ create: number; update: number; delete: number; total: number }> {
  const where =
    from !== undefined || to !== undefined
      ? {
          occurredAt: {
            ...(from !== undefined && { gte: from }),
            ...(to !== undefined && { lte: to }),
          },
        }
      : {};

  const grouped = await prismaBase.auditLog.groupBy({
    by: ['action'],
    where,
    _count: { _all: true },
  });
  const counts = { create: 0, update: 0, delete: 0, total: 0 };
  for (const g of grouped) {
    counts.total += g._count._all;
    if (g.action === 'CREATE') counts.create = g._count._all;
    else if (g.action === 'UPDATE') counts.update = g._count._all;
    else if (g.action === 'DELETE') counts.delete = g._count._all;
  }
  return counts;
}
