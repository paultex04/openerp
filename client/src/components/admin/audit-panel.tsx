'use client';

/**
 * Audit log.
 *
 * Search, filter, sort and paginate - but deliberately **no** create, edit or
 * delete, and the omission is the design rather than an oversight.
 *
 * The audit trail exists to answer "who changed what, when". An editable or
 * deletable audit log answers that question only as far as whoever edited the log
 * wanted it to, which makes it worse than no log at all: it looks like evidence.
 * Entries are written by a Prisma extension on the write path, and nothing in
 * the API can modify or remove one. See ADR-005.
 *
 * Filtering is done client-side. The endpoint caps at 100 entries and has no
 * offset parameter, so client-side paging over that window is the honest option;
 * a production deployment needs server-side paging over a much larger table, and
 * that is called out in ADR-006 rather than faked here.
 */
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DataTable } from '@/components/data-table/data-table';
import { api, ApiError } from '@/lib/api';

interface AuditEntry {
  id: string;
  occurredAt: string;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  model: string;
  recordId: string | null;
  summary: string | null;
  changedFields: string[];
  route: string | null;
  method: string | null;
  after: Record<string, unknown> | null;
}

export function AuditPanel() {
  const [modelFilter, setModelFilter] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const [inspecting, setInspecting] = useState<AuditEntry | null>(null);

  const models = useQuery({
    queryKey: ['audit-models'],
    queryFn: () => api.get<{ models: string[] }>('/api/admin/audit/models'),
  });

  const summary = useQuery({
    queryKey: ['audit-summary'],
    queryFn: () =>
      api.get<{
        activity: { create: number; update: number; delete: number; total: number };
        auditWriteFailures: number;
      }>('/api/admin/audit/summary'),
  });

  const entries = useQuery({
    // Fetched unfiltered: filtering happens in the table so search, filters and
    // sorting are one mechanism rather than two that can disagree.
    queryKey: ['audit'],
    queryFn: () => api.get<{ entries: AuditEntry[]; total: number }>('/api/admin/audit?limit=200'),
  });

  const rows = entries.data?.entries ?? [];

  const modelOptions = useMemo(
    () => [
      { value: '', label: 'All models' },
      ...(models.data?.models ?? []).map((model) => ({ value: model, label: model })),
    ],
    [models.data],
  );

  const columns = useMemo<ColumnDef<AuditEntry, unknown>[]>(
    () => [
      {
        id: 'occurredAt',
        accessorKey: 'occurredAt',
        header: 'When',
        cell: ({ row }) => (
          <span className="text-xs whitespace-nowrap">
            {new Date(row.original.occurredAt).toLocaleString('en-ZA')}
          </span>
        ),
      },
      {
        id: 'actor',
        header: 'Actor',
        // Sorts on a derived string so "—" sorts last rather than first.
        accessorFn: (row) => row.actorEmail ?? row.actorName ?? 'zzzz',
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.actorEmail ?? row.original.actorName ?? 'system'}
          </span>
        ),
      },
      {
        id: 'action',
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <Badge
            variant={
              row.original.action === 'CREATE'
                ? 'success'
                : row.original.action === 'DELETE'
                  ? 'destructive'
                  : 'secondary'
            }
          >
            {row.original.action}
          </Badge>
        ),
      },
      {
        id: 'model',
        accessorKey: 'model',
        header: 'Model',
        cell: ({ row }) => <span className="font-mono text-[11px]">{row.original.model}</span>,
      },
      {
        id: 'summary',
        header: 'Change',
        cell: ({ row }) => (
          <span className="text-xs">
            {row.original.summary ?? `${row.original.model} ${row.original.recordId ?? ''}`}
          </span>
        ),
      },
      {
        id: 'route',
        header: 'Route',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-mono text-[10px] whitespace-nowrap text-muted-foreground">
            {row.original.method ? `${row.original.method} ${row.original.route}` : '—'}
          </span>
        ),
      },
    ],
    [],
  );

  const activity = summary.data?.activity;

  return (
    <div className="space-y-4">
      {activity && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Tile label="Entries" value={activity.total} />
          <Tile label="Created" value={activity.create} />
          <Tile label="Updated" value={activity.update} />
          <Tile label="Deleted" value={activity.delete} />
        </div>
      )}

      {summary.data && summary.data.auditWriteFailures > 0 && (
        <p className="rounded-md border border-negative/40 bg-negative/10 p-2 text-xs text-negative">
          {summary.data.auditWriteFailures} audit write(s) failed. Entries may be missing; see the
          server log.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Append-only. Entries are written by the database layer and cannot be edited or removed -
        that is what makes this usable as evidence.
      </p>

      {entries.isError ? (
        <p className="text-sm text-negative">
          {entries.error instanceof ApiError ? entries.error.message : 'Could not load the log.'}
        </p>
      ) : (
        <DataTable<AuditEntry>
          caption="Audit log"
          data={rows}
          columns={columns}
          rowKey={(entry) => entry.id}
          searchKeys={['summary', 'model', 'actorEmail', 'actorName', 'route', 'recordId']}
          searchPlaceholder="Search actor, model, route or record…"
          isLoading={entries.isLoading}
          // Newest first is the only useful default for a log.
          initialSort={[{ id: 'occurredAt', desc: true }]}
          pageSize={25}
          emptyMessage="No audit entries match the current search and filters."
          filters={[
            {
              id: 'model',
              label: 'Model',
              value: modelFilter,
              options: modelOptions,
              onChange: setModelFilter,
              predicate: (entry, selected) => entry.model === selected,
            },
            {
              id: 'action',
              label: 'Action',
              value: actionFilter,
              options: [
                { value: '', label: 'All actions' },
                { value: 'CREATE', label: 'CREATE' },
                { value: 'UPDATE', label: 'UPDATE' },
                { value: 'DELETE', label: 'DELETE' },
              ],
              onChange: setActionFilter,
              predicate: (entry, selected) => entry.action === selected,
            },
          ]}
          renderRowActions={(entry) => (
            <Button size="sm" variant="ghost" onClick={() => setInspecting(entry)}>
              Inspect
            </Button>
          )}
        />
      )}

      {/*
        Detail moved out of the row and into a dialog. Inline expansion inside a
        sortable, paginated table is where the layout fights the data: a tall
        expanded row breaks the sort, and the expansion state has to be tracked per
        row for no benefit over a dialog that shows the same JSON properly.
      */}
      <Dialog open={inspecting !== null} onOpenChange={(open) => !open && setInspecting(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{inspecting?.summary ?? `${inspecting?.model} entry`}</DialogTitle>
            <DialogDescription>
              {inspecting?.actorEmail ?? inspecting?.actorName ?? 'system'} ·{' '}
              {inspecting ? new Date(inspecting.occurredAt).toLocaleString('en-ZA') : ''}
              {inspecting?.route ? ` · ${inspecting.method} ${inspecting.route}` : ''}
            </DialogDescription>
          </DialogHeader>

          {inspecting && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {(inspecting.changedFields ?? []).map((field) => (
                  <Badge key={field} variant="outline">
                    {field}
                  </Badge>
                ))}
              </div>
              {/*
                A <pre> for a JSON payload is the right call. It is preformatted
                data whose alignment carries meaning, and a table or list would
                obscure that.
              */}
              <pre className="max-h-80 overflow-auto rounded-md border bg-muted p-3 text-[11px]">
                {JSON.stringify(inspecting.after ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
