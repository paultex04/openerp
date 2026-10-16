'use client';

/**
 * "New job": create a job from the register.
 *
 * ## What this restores
 *
 * Job creation originally lived in the generic master-data panel. When Operations
 * became the Job Management page that panel was removed and nothing replaced it,
 * so `POST /api/jobs` kept working while the register had no way to reach it. This
 * dialog is that form, rebuilt for this page with the same fields.
 *
 * ## The amendment follows the project
 *
 * A job with no amendment of its own inherits its project's (the Phase 3
 * resolution rule), so the picker lists only the chosen project's contract's
 * amendments and leaving it blank is the normal case, not an error. Offering
 * every amendment in the system would let the user pick a pair the server
 * rejects with a 422 — resolving project → contract → amendments is what stops
 * that.
 *
 * Status is deliberately not a field: a job is born at 01. Scoping and moves
 * happen only through `POST /api/jobs/:id/transition`. Actual dates are not
 * fields either — supervisors enter them at the point of work, not the planning
 * office.
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { usePermissions } from '@/components/auth/usePermissions';

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

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

/** Blank optional text becomes `null`, never an empty string the API stores. */
const blank = (value: string) => (value.trim() === '' ? null : value.trim());

/** Blank optional ids become `null` ("inherit" / "unassigned" / "none"). */
const blankId = (value: string) => (value === '' ? null : Number(value));

export function AddJobDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (jobId: number) => void;
}) {
  const queryClient = useQueryClient();
  const { can } = usePermissions();

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
  const [error, setError] = useState<string | null>(null);

  // Each picker is only fetched when the operator may read it; a role can hold
  // `job.write` without the reference-data reads, and a 403 there should leave an
  // empty picker rather than a failed dialog.
  const projects = useQuery({
    queryKey: ['projects', 'options'],
    queryFn: () => api.get<{ projects: ProjectRow[] }>('/api/projects'),
    enabled: can('project.read'),
  });
  const amendments = useQuery({
    queryKey: ['amendments', 'options'],
    queryFn: () => api.get<{ amendments: AmendmentOption[] }>('/api/amendments'),
    enabled: can('amendment.read'),
  });
  const employees = useQuery({
    queryKey: ['employees', 'options'],
    queryFn: () => api.get<{ employees: EmployeeOption[] }>('/api/employees'),
    enabled: can('employee.read'),
  });
  const contacts = useQuery({
    queryKey: ['contacts', 'options'],
    queryFn: () => api.get<{ contacts: ContactOption[] }>('/api/contacts'),
    enabled: can('contact.read'),
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
    onError: (caught) =>
      setError(caught instanceof ApiError ? caught.message : 'Could not create the job.'),
  });

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>
            Jobs start at 01. Add its scope from the job view; move it through the lifecycle from
            there once it is scoped.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto pr-1">
          <Card>
            <CardHeader>
              <CardTitle>Project &amp; commercial basis</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-job-project">Project *</FieldLabel>
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-amendment">Amendment</FieldLabel>
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
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-job-supervisor">Supervisor</FieldLabel>
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
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-contact">Client contact</FieldLabel>
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
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Job references</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-job-wo">Work order</FieldLabel>
                  <Input
                    id="new-job-wo"
                    value={workOrder}
                    onChange={(event) => setWorkOrder(event.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-wo-date">WO received</FieldLabel>
                  <Input
                    id="new-job-wo-date"
                    type="date"
                    value={workOrderReceivedDate}
                    onChange={(event) => setWorkOrderReceivedDate(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-po">Purchase order</FieldLabel>
                  <Input
                    id="new-job-po"
                    value={purchaseOrder}
                    onChange={(event) => setPurchaseOrder(event.target.value)}
                    className="font-mono"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-po-date">PO received</FieldLabel>
                  <Input
                    id="new-job-po-date"
                    type="date"
                    value={purchaseOrderReceivedDate}
                    onChange={(event) => setPurchaseOrderReceivedDate(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-area">Area</FieldLabel>
                  <Input
                    id="new-job-area"
                    value={area}
                    onChange={(event) => setArea(event.target.value)}
                    placeholder="e.g. Substation 6"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-priority">Priority</FieldLabel>
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
                </Field>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Schedule &amp; scope</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="new-job-planned-start">Planned start</FieldLabel>
                  <Input
                    id="new-job-planned-start"
                    type="date"
                    value={plannedStartDate}
                    onChange={(event) => setPlannedStartDate(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="new-job-planned-end">Planned end</FieldLabel>
                  <Input
                    id="new-job-planned-end"
                    type="date"
                    value={plannedEndDate}
                    onChange={(event) => setPlannedEndDate(event.target.value)}
                  />
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="new-job-description">Description</FieldLabel>
                  <textarea
                    id="new-job-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                  />
                </Field>
              </div>
            </CardContent>
          </Card>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => create.mutate()}
            disabled={!projectId || create.isPending}
          >
            {create.isPending && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
            Create job
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
