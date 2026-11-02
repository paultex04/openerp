'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  Loader2,
  LogIn,
  Search,
  XCircle,
} from 'lucide-react';
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
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { api, type AccessRequestStatusResponse } from '@/lib/api';

interface CheckStatusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEmail?: (email: string) => void;
  onSwitchToRequest?: () => void;
}

export function CheckStatusDialog({
  open,
  onOpenChange,
  onSelectEmail,
  onSwitchToRequest,
}: CheckStatusDialogProps) {
  const [emailInput, setEmailInput] = useState('');
  const [queriedEmail, setQueriedEmail] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: ['access-request-status', queriedEmail],
    queryFn: () =>
      api.get<AccessRequestStatusResponse>('/api/auth/access-requests/status', {
        email: queriedEmail!,
      }),
    enabled: Boolean(queriedEmail),
    retry: false,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (emailInput.trim()) {
      setQueriedEmail(emailInput.trim().toLowerCase());
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setEmailInput('');
      setQueriedEmail(null);
    }
    onOpenChange(nextOpen);
  };

  const request = statusQuery.data?.request;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Search className="size-4" />
            </div>
            <div>
              <DialogTitle>Check Access Request Status</DialogTitle>
              <DialogDescription>
                Enter your work email address to check the current review status.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSearch} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="status-email">Work Email</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="status-email"
                type="email"
                required
                placeholder="name@company.co.za"
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                className="flex-1"
              />
              <Button type="submit" disabled={statusQuery.isFetching} className="cursor-pointer">
                {statusQuery.isFetching ? <Loader2 className="size-4 animate-spin" /> : 'Lookup'}
              </Button>
            </div>
          </Field>
        </form>

        {/* Results Area */}
        {queriedEmail && !statusQuery.isFetching && (
          <div className="pt-2">
            {statusQuery.data && !statusQuery.data.found && (
              <Alert className="border-border bg-muted/30">
                <AlertCircle className="size-4 text-muted-foreground" />
                <AlertTitle>No Request Found</AlertTitle>
                <AlertDescription className="space-y-2 mt-1">
                  <p>
                    There are no active or recent access requests registered for{' '}
                    <strong>{queriedEmail}</strong>.
                  </p>
                  {onSwitchToRequest && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="px-0 h-auto font-medium"
                      onClick={() => {
                        handleOpenChange(false);
                        onSwitchToRequest();
                      }}
                    >
                      Click here to submit an access request →
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}

            {request && (
              <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3.5 shadow-xs">
                <div className="flex items-center justify-between border-b border-border/50 pb-2.5">
                  <div>
                    <h4 className="font-semibold text-sm">{request.fullName}</h4>
                    <p className="text-xs text-muted-foreground">
                      {request.department || 'General'}
                    </p>
                  </div>
                  <div>
                    {request.status === 'Pending' && (
                      <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 gap-1.5">
                        <Clock className="size-3" />
                        Pending Review
                      </Badge>
                    )}
                    {request.status === 'Approved' && (
                      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1.5">
                        <CheckCircle2 className="size-3" />
                        Approved
                      </Badge>
                    )}
                    {request.status === 'Rejected' && (
                      <Badge className="bg-destructive/15 text-destructive border-destructive/30 gap-1.5">
                        <XCircle className="size-3" />
                        Declined
                      </Badge>
                    )}
                  </div>
                </div>

                <div className="text-xs space-y-2">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Calendar className="size-3.5" />
                    <span>
                      Submitted on{' '}
                      {new Date(request.createdAt).toLocaleDateString('en-ZA', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>

                  {request.status === 'Pending' && (
                    <p className="text-muted-foreground leading-relaxed pt-1">
                      Your request is currently awaiting review by a system administrator. You will
                      receive notification once your account credentials are created.
                    </p>
                  )}

                  {request.status === 'Approved' && (
                    <div className="space-y-2.5 pt-1">
                      <p className="text-emerald-700 dark:text-emerald-400 font-medium">
                        Your account has been provisioned! You can now sign in using this email
                        address.
                      </p>
                      {onSelectEmail && (
                        <Button
                          type="button"
                          className="w-full h-8 text-xs gap-1.5 cursor-pointer"
                          onClick={() => {
                            onSelectEmail(request.email);
                            handleOpenChange(false);
                          }}
                        >
                          <LogIn className="size-3.5" />
                          Proceed to Sign In
                        </Button>
                      )}
                    </div>
                  )}

                  {request.status === 'Rejected' && (
                    <div className="space-y-2 pt-1 text-destructive">
                      <p className="font-medium">Request declined by administrator.</p>
                      {request.adminNotes && (
                        <div className="rounded-lg bg-destructive/10 p-2.5 text-xs text-foreground/90 border border-destructive/20">
                          <span className="font-semibold block mb-0.5">Admin feedback:</span>
                          {request.adminNotes}
                        </div>
                      )}
                      {onSwitchToRequest && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="w-full mt-2"
                          onClick={() => {
                            handleOpenChange(false);
                            onSwitchToRequest();
                          }}
                        >
                          Submit a New Request
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
