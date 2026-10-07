'use client';

/**
 * "New job": create a job from the register.
 *
 * ## What this restores
 *
 * Job creation previously lived in the generic master-data panel and was removed
 * with it when Operations became the Job Management page — leaving no way to
 * create a job through the UI at all, while `POST /api/jobs` kept working. This
 * dialog is that form, rebuilt for this page with the same fields.
 *
 * ## The amendment follows the project
 *
 * A job with no amendment of its own inherits its project's (the Phase 3
 * resolution rule), so the picker lists only the chosen project's contract's
 * amendments and leaving it blank is the normal case, not an error. Offering
 * every amendment in the system would let the user pick a pair the server
 * rejects with a 422 — that exact bug existed here before and was fixed by
 * resolving project → contract → amendments.
 *
 * Status is deliberately not a field: a job is born at 01. Scoping and moves
 * only through `POST /api/jobs/:id/transition`. Actual dates are not fields
 * either — supervisors enter them at the point of work, not the planning office.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { jobPriorityValues } from '@openerp/shared';
import { api, ApiError, type ProjectRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';

interface AmendmentOption {
  id: number;
  contractId: number;
  amendmentNumber: string;
  status: string;
}

interface EmployeeOption {
  id: number;
  fullName: string;
  isActive: boolean;
}

interface ContactOption {
  id: number;
  name: string;
}

const inputClass = 'h-8 text-xs';
const labelClass = 'text-xs font-medium text-muted-foreground';
const selectClass =
  'h-8 w-full rounded-md border border-input bg-background px-2 text-sm';

export function AddJobDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (jobId: number) => void;
}) {
  const queryClient = useQueryClient();

  const [projectId, setProjectId] = useState('');
  const [amendmentId, setAmendmentId] = useState('');
  const [supervisorId, setSupervisorId] = useState('');
  const [clientContactId, setClientContactId] = useState('');
  const [workOrder, setWorkOrder] = useState('');
  const [workOrderReceivedDate, setWorkOrderReceivedDate] = useState('');
  const [purchaseOrder, setPurchaseOrder] = useState('');
  const [purchaseOrderReceivedDate, setPurchaseOrderReceivedDate] = useState('');
  const [plannedStartDate, setPlannedStartDate] = useState('');
  const [plannedEndDate, setPlannedEndDate] = useState('');
  const [area, setArea] = useState('');
  const [priority, setPriority] = useState<string>('P3 - Routine / Normal');
  const [description, setDescription] = useState('');

  const projects = useQuery({
    queryKey: ['projects', 'options'],
    queryFn: () => api.get<{ projects: ProjectRow[] }>('/api/projects'),
  });
  const amendments = useQuery({
    queryKey: ['amendments', 'options'],
    queryFn: () => api.get<{ amendments: AmendmentOption[] }>('/api/amendments'),
  });
  const employees = useQuery({
    queryKey: ['employees', 'options'],
    queryFn: () =>
      api.get<{ employees: EmployeeOption[] }>('/api/employees'),
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'options'],
    queryFn: () => api.get<{ contacts: ContactOption[] }>('/api/contacts'),
  });

  // The chosen project's contract decides which amendments are offered. A
  // previously chosen amendment from another contract is dropped, not kept —
  // keeping it would submit a pair the server rejects.
  const contractId = useMemo(() => {
    const project = (projects.data?.projects ?? []).find((p) => String(p.id) === projectId);
    return project?.contract.id ?? null;
  }, [projects.data, projectId]);

  const amendmentOptions = useMemo(
    () =>
      contractId === null
        ? []
        : (amendments.data?.amendments ?? [])
            .filter((a) => a.contractId === contractId)
            .map((a) => ({ value: String(a.id), label: `${a.amendmentNumber} (${a.status})` })),
    [amendments.data, contractId],
  );

  const pickProject = (next: string) => {
    setProjectId(next);
    // Re-resolve the amendment against the new project's contract immediately,
    // so the form can never hold a cross-contract pair, even for a frame.
    const project = (projects.data?.projects ?? []).find((p) => String(p.id) === next);
    const nextContractId = project?.contract.id ?? null;
    if (nextContractId === null) {
      setAmendmentId('');
      return;
    }
    const stillValid = (amendments.data?.amendments ?? []).some(
      (a) => String(a.id) === amendmentId && a.contractId === nextContractId,
    );
    if (!stillValid) setAmendmentId('');
  };

  const blank = (value: string) => (value.trim() === '' ? null : value.trim());
  const blankId = (value: string) => (value === '' ? null : Number(value));

  const create = useMutation({
    mutationFn: () =>
      api.post<{ job: { id: number } }>('/api/jobs', {
        projectId: Number(projectId),
        // Null means "inherit the project's amendment" — the normal case, and
        // why the picker is allowed to stay blank.
        amendmentId: blankId(amendmentId),
        supervisorId: blankId(supervisorId),
        clientContactId: blankId(clientContactId),
        priority,
        workOrder: blank(workOrder),
        workOrderReceivedDate: blank(workOrderReceivedDate),
        purchaseOrder: blank(purchaseOrder),
        purchaseOrderReceivedDate: blank(purchaseOrderReceivedDate),
        plannedStartDate: blank(plannedStartDate),
        plannedEndDate: blank(plannedEndDate),
        area: blank(area),
        description: blank(description),
      }),
    onSuccess: (result) => {
      toast.add({ title: `Job #${result.job.id} created`, type: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['jobs', 'register'] });
      onCreated(result.job.id);
    },
    onError: (error: Error) =>
      toast.add({
        title: 'Could not create the job',
        description: error instanceof ApiError ? error.message : error.message,
        type: 'error',
      }),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Jobs start at 01. Scoping. Move it through the lifecycle from the job
            view once scoped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Project &amp; commercial basis</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="new-job-project" className={labelClass}>
                    Project *
                  </label>
                  <select
                    id="new-job-project"
                    value={projectId}
                    onChange={(event) => pickProject(event.target.value)}
                    className={selectClass}
                  >
                    <option value="">Choose…</option>
                    {(projects.data?.projects ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-amendment" className={labelClass}>
                    Amendment
                  </label>
                  <select
                    id="new-job-amendment"
                    value={amendmentId}
                    onChange={(event) => setAmendmentId(event.target.value)}
                    className={selectClass}
                  >
                    <option value="">
                      {projectId ? 'Inherit the project’s amendment' : 'Choose a project first'}
                    </option>
                    {amendmentOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="new-job-supervisor" className={labelClass}>
                    Supervisor
                  </label>
                  <select
                    id="new-job-supervisor"
                    value={supervisorId}
                    onChange={(event) => setSupervisorId(event.target.value)}
                    className={selectClass}
                  >
                    <option value="">Unassigned</option>
                    {(employees.data?.employees ?? [])
                      .filter((e) => e.isActive)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.fullName}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-contact" className={labelClass}>
                    Client contact
                  </label>
                  <select
                    id="new-job-contact"
                    value={clientContactId}
                    onChange={(event) => setClientContactId(event.target.value)}
                    className={selectClass}
                  >
                    <option value="">None</option>
                    {(contacts.data?.contacts ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Job references</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="new-job-wo" className={labelClass}>
                    Work order
                  </label>
                  <Input
                    id="new-job-wo"
                    value={workOrder}
                    onChange={(event) => setWorkOrder(event.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-wo-date" className={labelClass}>
                    WO received
                  </label>
                  <Input
                    id="new-job-wo-date"
                    type="date"
                    value={workOrderReceivedDate}
                    onChange={(event) => setWorkOrderReceivedDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-po" className={labelClass}>
                    Purchase order
                  </label>
                  <Input
                    id="new-job-po"
                    value={purchaseOrder}
                    onChange={(event) => setPurchaseOrder(event.target.value)}
                    className="h-8 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-po-date" className={labelClass}>
                    PO received
                  </label>
                  <Input
                    id="new-job-po-date"
                    type="date"
                    value={purchaseOrderReceivedDate}
                    onChange={(event) => setPurchaseOrderReceivedDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-area" className={labelClass}>
                    Area
                  </label>
                  <Input
                    id="new-job-area"
                    value={area}
                    onChange={(event) => setArea(event.target.value)}
                    placeholder="e.g. Substation 6"
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-priority" className={labelClass}>
                    Priority
                  </label>
                  <select
                    id="new-job-priority"
                    value={priority}
                    onChange={(event) => setPriority(event.target.value)}
                    className={selectClass}
                  >
                    {jobPriorityValues.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Schedule &amp; scope</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label htmlFor="new-job-planned-start" className={labelClass}>
                    Planned start
                  </label>
                  <Input
                    id="new-job-planned-start"
                    type="date"
                    value={plannedStartDate}
                    onChange={(event) => setPlannedStartDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="new-job-planned-end" className={labelClass}>
                    Planned end
                  </label>
                  <Input
                    id="new-job-planned-end"
                    type="date"
                    value={plannedEndDate}
                    onChange={(event) => setPlannedEndDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <label htmlFor="new-job-description" className={labelClass}>
                    Description
                  </label>
                  <textarea
                    id="new-job-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!projectId || create.isPending}>
            {create.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
