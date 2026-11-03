'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  LifeBuoy,
  Terminal,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCurrentUser } from '@/components/auth/usePermissions';

export interface IncidentDetails {
  title?: string;
  error?: string;
  stack?: string;
  incidentRef?: string;
}

const INCIDENT_EVENT_NAME = 'openerp:incident-report';

/**
 * Triggers the incident report modal from anywhere in the client.
 */
export function openIncidentReport(details?: IncidentDetails): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<IncidentDetails | undefined>(INCIDENT_EVENT_NAME, {
      detail: details,
    }),
  );
}

export function IncidentReportModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [details, setDetails] = useState<IncidentDetails | null>(null);
  const [userNotes, setUserNotes] = useState('');
  const [copied, setCopied] = useState(false);
  const [incidentId, setIncidentId] = useState('');
  const [incidentUrl, setIncidentUrl] = useState('');
  const [timestamp, setTimestamp] = useState('');

  const { data: currentUser } = useCurrentUser();

  const handleOpenEvent = useCallback((event: Event) => {
    const customEvent = event as CustomEvent<IncidentDetails | undefined>;
    const customDetails = customEvent.detail ?? {};
    setDetails(customDetails);
    setUserNotes('');
    setCopied(false);

    const generatedId =
      customDetails.incidentRef ||
      `INC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random()
        .toString(36)
        .substring(2, 7)
        .toUpperCase()}`;
    setIncidentId(generatedId);
    setIncidentUrl(typeof window !== 'undefined' ? window.location.href : 'Unknown');
    setTimestamp(new Date().toISOString());
    setIsOpen(true);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(INCIDENT_EVENT_NAME, handleOpenEvent);
    return () => {
      window.removeEventListener(INCIDENT_EVENT_NAME, handleOpenEvent);
    };
  }, [handleOpenEvent]);

  const userDisplayName = currentUser
    ? `${currentUser.employee.name} ${currentUser.employee.surname}`
    : 'Authenticated User';
  const userEmail = currentUser?.user.email ?? 'N/A';
  const userRoles = currentUser?.roles?.join(', ') || 'N/A';
  const browserInfo = typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown';
  const screenResolution =
    typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'N/A';

  const formatMarkdownReport = (): string => {
    const sections: string[] = [
      `### 🚨 OpenERP Incident Report: \`${incidentId}\``,
      ``,
      `- **Date / Time:** ${timestamp}`,
      `- **Active URL:** ${incidentUrl}`,
      `- **Reporter:** ${userDisplayName} (${userEmail})`,
      `- **Assigned Roles:** ${userRoles}`,
      `- **Environment:** Browser: \`${browserInfo}\` (Viewport: ${screenResolution})`,
    ];

    if (details?.title) {
      sections.push(``, `#### Context / Trigger`, `> ${details.title}`);
    }

    if (userNotes.trim()) {
      sections.push(``, `#### User Description & Steps to Reproduce`, userNotes.trim());
    }

    if (details?.error) {
      sections.push(
        ``,
        `#### Error Diagnostics`,
        `\`\`\`text`,
        details.error,
        details.stack ? `\nStack trace:\n${details.stack}` : '',
        `\`\`\``,
      );
    }

    sections.push(
      ``,
      `---`,
      `*Report generated directly from OpenERP Incident Diagnostics modal.*`,
    );

    return sections.filter((line) => line !== undefined).join('\n');
  };

  const handleCopy = async () => {
    const markdown = formatMarkdownReport();
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="max-w-2xl sm:max-w-2xl p-6 rounded-2xl">
        <DialogHeader className="gap-1.5 text-left border-b border-border/60 pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <LifeBuoy className="size-4" />
              </div>
              <DialogTitle className="text-base font-semibold">
                Report Issue / Incident Diagnostic
              </DialogTitle>
            </div>
            <Badge variant="outline" className="font-mono text-[10px] px-2 py-0.5">
              {incidentId}
            </Badge>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Generate an engineering ticket with diagnostic runtime telemetry, browser state, and
            contextual error details.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          {/* Metadata Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] rounded-xl bg-muted/40 p-3 border border-border/60">
            <div>
              <span className="text-muted-foreground">Active URL:</span>
              <p className="font-mono font-medium truncate text-foreground" title={incidentUrl}>
                {incidentUrl}
              </p>
            </div>
            <div>
              <span className="text-muted-foreground">Reporter:</span>
              <p className="font-medium text-foreground truncate">
                {userDisplayName} ({userEmail})
              </p>
            </div>
          </div>

          {/* Error Message if present */}
          {details?.error && (
            <div className="space-y-1">
              <label className="font-medium text-destructive flex items-center gap-1.5 text-xs">
                <AlertTriangle className="size-3.5" />
                Detected Error Message
              </label>
              <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl font-mono text-[11px] text-destructive break-all max-h-32 overflow-y-auto">
                {details.error}
                {details.stack && (
                  <pre className="mt-2 text-[10px] text-muted-foreground whitespace-pre-wrap">
                    {details.stack}
                  </pre>
                )}
              </div>
            </div>
          )}

          {/* User Notes Input */}
          <div className="space-y-1.5">
            <label htmlFor="user-incident-notes" className="font-medium text-foreground text-xs">
              What were you doing when this issue occurred?
            </label>
            <textarea
              id="user-incident-notes"
              rows={3}
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder="e.g. Trying to upload an avatar in user profile, or approving Week 44 timesheet..."
              className="w-full rounded-xl border border-input bg-background/80 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Markdown Preview Notice */}
          <div className="flex items-center gap-2 rounded-lg bg-primary/5 p-2.5 text-[11px] text-muted-foreground border border-primary/10">
            <Terminal className="size-4 text-primary shrink-0" />
            <span>
              Clicking <strong>&quot;Copy Markdown Ticket&quot;</strong> formats all data into a
              Slack/Teams/Forgejo issue template ready to paste.
            </span>
          </div>
        </div>

        <DialogFooter className="flex-row items-center justify-between sm:justify-between border-t border-border/60 pt-3 gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setIsOpen(false)}
            className="text-xs"
          >
            Cancel
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() => void handleCopy()}
              className="gap-1.5 text-xs font-medium"
            >
              {copied ? (
                <>
                  <Check className="size-3.5 text-emerald-400" />
                  Copied to Clipboard!
                </>
              ) : (
                <>
                  <Copy className="size-3.5" />
                  Copy Markdown Ticket
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
