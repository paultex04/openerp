'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  UserCheck,
  UserX,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { DataTable } from '@/components/data-table/data-table';
import { usePermissions } from '@/components/auth/usePermissions';
import {
  api,
  ApiError,
  type AccessRequestRow,
  type ApproveAccessRequestInput,
  type RejectAccessRequestInput,
} from '@/lib/api';

const AVAILABLE_ROLES = [
  { key: 'commercial_qs', label: 'Commercial / QS', desc: 'Contracts, rates, recipes & estimates' },
  {
    key: 'site_supervisor',
    label: 'Site Supervisor',
    desc: 'Job management, crew & daily progress',
  },
  { key: 'billing_clerk', label: 'Billing Clerk', desc: 'Timesheet billing & invoice processing' },
  {
    key: 'project_manager',
    label: 'Project Manager',
    desc: 'Project oversight & lifecycle milestones',
  },
  { key: 'viewer', label: 'Read-Only Viewer', desc: 'General system view access' },
  {
    key: 'administrator',
    label: 'System Administrator',
    desc: 'Full administration & security access',
  },
];

export function AccessRequestsPanel() {
  const queryClient = useQueryClient();
  const { can } = usePermissions();
  const canWrite = can('admin.user.write');

  const [statusFilter, setStatusFilter] = useState<'All' | 'Pending' | 'Approved' | 'Rejected'>(
    'Pending',
  );
  const [approvingRequest, setApprovingRequest] = useState<AccessRequestRow | null>(null);
  const [rejectingRequest, setRejectingRequest] = useState<AccessRequestRow | null>(null);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ['admin-access-requests', statusFilter],
    queryFn: () =>
      api.get<{ requests: AccessRequestRow[] }>('/api/admin/access-requests', {
        status: statusFilter,
      }),
  });

  const requests = data?.requests ?? [];

  const columns = useMemo<ColumnDef<any, AccessRequestRow, unknown>[]>(
    () => [
      {
        id: 'requester',
        header: 'Requester',
        accessorFn: (r) => `${r.fullName} ${r.email}`,
        cell: ({ row }) => (
          <div>
            <div className="font-medium text-foreground">{row.original.fullName}</div>
            <div className="text-xs text-muted-foreground">{row.original.email}</div>
          </div>
        ),
      },
      {
        id: 'department',
        header: 'Department / Role',
        accessorKey: 'department',
        cell: ({ row }) => (
          <div>
            <div className="text-sm font-medium">{row.original.department || '—'}</div>
            {row.original.jobTitle && (
              <div className="text-xs text-muted-foreground">{row.original.jobTitle}</div>
            )}
          </div>
        ),
      },
      {
        id: 'phone',
        header: 'Contact',
        accessorKey: 'phone',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {row.original.phone || '—'}
          </span>
        ),
      },
      {
        id: 'reason',
        header: 'Justification',
        accessorKey: 'reason',
        cell: ({ row }) => (
          <div
            className="max-w-xs truncate text-xs text-muted-foreground"
            title={row.original.reason}
          >
            {row.original.reason}
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessorKey: 'status',
        cell: ({ row }) => {
          const status = row.original.status;
          if (status === 'Pending') {
            return (
              <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 gap-1">
                <Clock className="size-3" />
                Pending
              </Badge>
            );
          }
          if (status === 'Approved') {
            return (
              <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1">
                <CheckCircle2 className="size-3" />
                Approved
              </Badge>
            );
          }
          return (
            <Badge className="bg-destructive/15 text-destructive border-destructive/30 gap-1">
              <XCircle className="size-3" />
              Declined
            </Badge>
          );
        },
      },
      {
        id: 'createdAt',
        header: 'Requested Date',
        accessorKey: 'createdAt',
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {new Date(row.original.createdAt).toLocaleDateString('en-ZA', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </span>
        ),
      },
      {
        id: 'reviewInfo',
        header: 'Reviewer',
        cell: ({ row }) => {
          if (!row.original.reviewedBy)
            return <span className="text-xs text-muted-foreground">—</span>;
          return (
            <div className="text-xs">
              <span className="font-medium text-foreground">{row.original.reviewedBy.name}</span>
              {row.original.adminNotes && (
                <div
                  className="text-[11px] text-muted-foreground truncate max-w-[150px]"
                  title={row.original.adminNotes}
                >
                  {row.original.adminNotes}
                </div>
              )}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {/* Tab Filter & Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 p-1 text-xs">
          {(['Pending', 'Approved', 'Rejected', 'All'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setStatusFilter(tab)}
              className={`rounded-md px-3 py-1 font-medium transition-colors cursor-pointer ${
                statusFilter === tab
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          className="gap-1.5 text-xs cursor-pointer"
        >
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      <DataTable<AccessRequestRow>
        caption="User access requests"
        columns={columns}
        data={requests}
        rowKey={(req) => req.id}
        searchKeys={['fullName', 'email', 'department', 'jobTitle', 'reason']}
        searchPlaceholder="Filter requests by name, email or department..."
        isLoading={isLoading}
        renderRowActions={(req) => {
          if (req.status !== 'Pending' || !canWrite) return null;
          return (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1 border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 cursor-pointer"
                onClick={() => setApprovingRequest(req)}
              >
                <UserCheck className="size-3.5" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1 text-destructive hover:bg-destructive/10 cursor-pointer"
                onClick={() => setRejectingRequest(req)}
              >
                <UserX className="size-3.5" />
                Decline
              </Button>
            </div>
          );
        }}
      />

      {/* Approve Dialog */}
      {approvingRequest && (
        <ApproveDialog
          request={approvingRequest}
          open={Boolean(approvingRequest)}
          onOpenChange={(open) => !open && setApprovingRequest(null)}
          onSuccess={() => {
            setApprovingRequest(null);
            queryClient.invalidateQueries({ queryKey: ['admin-access-requests'] });
            queryClient.invalidateQueries({ queryKey: ['admin-access-requests-pending-count'] });
          }}
        />
      )}

      {/* Reject Dialog */}
      {rejectingRequest && (
        <RejectDialog
          request={rejectingRequest}
          open={Boolean(rejectingRequest)}
          onOpenChange={(open) => !open && setRejectingRequest(null)}
          onSuccess={() => {
            setRejectingRequest(null);
            queryClient.invalidateQueries({ queryKey: ['admin-access-requests'] });
            queryClient.invalidateQueries({ queryKey: ['admin-access-requests-pending-count'] });
          }}
        />
      )}
    </div>
  );
}

function generateInitialPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let result = 'Pass#';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result + '!9';
}

function ApproveDialog({
  request,
  open,
  onOpenChange,
  onSuccess,
}: {
  request: AccessRequestRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [selectedRoles, setSelectedRoles] = useState<string[]>(['site_supervisor']);
  const [tempPassword, setTempPassword] = useState(generateInitialPassword);
  const [showPassword, setShowPassword] = useState(true);
  const [copied, setCopied] = useState(false);
  const [adminNotes, setAdminNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggleRole = (roleKey: string) => {
    setSelectedRoles((prev) =>
      prev.includes(roleKey) ? prev.filter((k) => k !== roleKey) : [...prev, roleKey],
    );
  };

  const copyPassword = () => {
    navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const approveMutation = useMutation({
    mutationFn: (payload: ApproveAccessRequestInput) =>
      api.post(`/api/admin/access-requests/${request.id}/approve`, payload),
    onSuccess: () => {
      toast.add({
        title: 'User provisioned successfully',
        description: `Account created for ${request.email} with temporary credentials.`,
        type: 'success',
      });
      onSuccess();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Failed to approve request.';
      setError(msg);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRoles.length === 0) {
      setError('Please assign at least one role to the new user.');
      return;
    }
    setError(null);
    approveMutation.mutate({
      roleKeys: selectedRoles,
      temporaryPassword: tempPassword,
      adminNotes: adminNotes.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <UserCheck className="size-4" />
              </div>
              <div>
                <DialogTitle>Approve Access &amp; Provision User</DialogTitle>
                <DialogDescription>
                  Provision an OpenERP account for <strong>{request.fullName}</strong> (
                  {request.email}).
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive border border-destructive/20">
              {error}
            </div>
          )}

          {/* Requester Summary */}
          <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Department:</span>
              <span className="font-medium">{request.department || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Job Title:</span>
              <span className="font-medium">{request.jobTitle || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Justification:</span>
              <span className="font-medium text-right max-w-xs">{request.reason}</span>
            </div>
          </div>

          {/* Role Assignment */}
          <Field>
            <FieldLabel>Assign Role(s) *</FieldLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              {AVAILABLE_ROLES.map((r) => {
                const checked = selectedRoles.includes(r.key);
                return (
                  <label
                    key={r.key}
                    className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-xs transition-colors cursor-pointer ${
                      checked
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border/60 hover:bg-muted/40 text-muted-foreground'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRole(r.key)}
                      className="rounded mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-foreground">{r.label}</div>
                      <div className="text-[11px] text-muted-foreground leading-tight">
                        {r.desc}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </Field>

          {/* Initial Temporary Password */}
          <Field>
            <FieldLabel htmlFor="initial-pw">Temporary Password *</FieldLabel>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="initial-pw"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  className="pr-16 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((p) => !p)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copyPassword}
                className="gap-1.5 cursor-pointer text-xs"
              >
                {copied ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </Field>

          {/* Admin Notes */}
          <Field>
            <FieldLabel htmlFor="admin-notes">Notes / Message for Requester (Optional)</FieldLabel>
            <Input
              id="admin-notes"
              placeholder="e.g. Welcome to the site operations team."
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
            />
          </Field>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={approveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={approveMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
            >
              {approveMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Provisioning…
                </>
              ) : (
                <>
                  <UserCheck className="size-4" />
                  Approve &amp; Create Account
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  request,
  open,
  onOpenChange,
  onSuccess,
}: {
  request: AccessRequestRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rejectMutation = useMutation({
    mutationFn: (payload: RejectAccessRequestInput) =>
      api.post(`/api/admin/access-requests/${request.id}/reject`, payload),
    onSuccess: () => {
      toast.add({
        title: 'Request declined',
        description: `Access request for ${request.email} has been declined.`,
        type: 'info',
      });
      onSuccess();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Failed to decline request.';
      setError(msg);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!notes.trim()) {
      setError('Please provide feedback or a reason for declining.');
      return;
    }
    setError(null);
    rejectMutation.mutate({ adminNotes: notes.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <UserX className="size-4" />
              </div>
              <div>
                <DialogTitle>Decline Access Request</DialogTitle>
                <DialogDescription>
                  Provide feedback for <strong>{request.fullName}</strong> explaining why access
                  cannot be granted.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive border border-destructive/20">
              {error}
            </div>
          )}

          <Field>
            <FieldLabel htmlFor="reject-notes">Feedback Reason *</FieldLabel>
            <textarea
              id="reject-notes"
              required
              rows={3}
              placeholder="e.g. Please coordinate with your department lead before requesting system access..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 resize-none"
            />
          </Field>

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={rejectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={rejectMutation.isPending}
              className="cursor-pointer"
            >
              {rejectMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Declining…
                </>
              ) : (
                'Confirm Decline'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
