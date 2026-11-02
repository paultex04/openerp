'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Send, UserPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { api, ApiError } from '@/lib/api';

interface RequestAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitchToCheckStatus?: () => void;
}

export function RequestAccessDialog({
  open,
  onOpenChange,
  onSwitchToCheckStatus,
}: RequestAccessDialogProps) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [department, setDepartment] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  const resetForm = () => {
    setFullName('');
    setEmail('');
    setPhone('');
    setDepartment('');
    setJobTitle('');
    setReason('');
    setError(null);
    setSubmittedEmail(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const submitMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; id: number; message: string }>('/api/auth/access-requests', {
        fullName,
        email,
        phone,
        department,
        jobTitle: jobTitle || undefined,
        reason,
      }),
    onSuccess: () => {
      setSubmittedEmail(email);
      setError(null);
    },
    onError: (err) => {
      const msg =
        err instanceof ApiError
          ? err.message
          : 'Could not submit your access request. Please try again.';
      setError(msg);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    submitMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {submittedEmail ? (
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-6" />
              </div>
              <DialogTitle className="text-lg font-bold">Access Request Submitted</DialogTitle>
              <DialogDescription className="text-center max-w-sm">
                Your request has been forwarded to the system administrators for review. You can
                track the progress of your request at any time using your email address.
              </DialogDescription>
            </div>

            <div className="rounded-xl border border-border/60 bg-muted/30 p-4 text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Requester Email:</span>
                <span className="font-semibold">{submittedEmail}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status:</span>
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  Pending Review
                </span>
              </div>
            </div>

            <DialogFooter className="mt-4 sm:justify-between flex-row">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  handleOpenChange(false);
                  onSwitchToCheckStatus?.();
                }}
              >
                Track Status
              </Button>
              <Button type="button" size="sm" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <UserPlus className="size-4" />
                </div>
                <div>
                  <DialogTitle>Request System Access</DialogTitle>
                  <DialogDescription>
                    Submit your details to request an account. An administrator will review your
                    application.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            {error && (
              <Alert variant="destructive">
                <AlertTitle>Submission Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <Field>
                <FieldLabel htmlFor="req-name">Full Name *</FieldLabel>
                <Input
                  id="req-name"
                  required
                  placeholder="e.g. Sipho Dlamini"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="req-email">Work Email *</FieldLabel>
                <Input
                  id="req-email"
                  type="email"
                  required
                  placeholder="name@company.co.za"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="req-phone">Phone / Mobile *</FieldLabel>
                <Input
                  id="req-phone"
                  required
                  placeholder="+27 82 123 4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="req-dept">Department / Trade *</FieldLabel>
                <Input
                  id="req-dept"
                  required
                  placeholder="e.g. Electrical / QA"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="req-title">Job Title (Optional)</FieldLabel>
              <Input
                id="req-title"
                placeholder="e.g. Senior Electrical Technician"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="req-reason">Business Justification *</FieldLabel>
              <textarea
                id="req-reason"
                required
                rows={3}
                placeholder="Describe your project assignment, site location, and why you need access..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 dark:bg-input/30 resize-none"
              />
            </Field>

            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={submitMutation.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitMutation.isPending} className="cursor-pointer">
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Submitting…
                  </>
                ) : (
                  <>
                    <Send className="size-4" />
                    Submit Request
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
