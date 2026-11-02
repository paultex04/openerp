'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Copy, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AccessDenied } from '@/components/auth/access-denied';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string; statusCode?: number; status?: number; code?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error('Unhandled Next.js Route Error:', error);
  }, [error]);

  const isForbidden =
    error.statusCode === 403 ||
    error.status === 403 ||
    error.code === 'FORBIDDEN' ||
    error.message?.toLowerCase().includes('forbidden') ||
    error.message?.toLowerCase().includes('unauthorized');

  if (isForbidden) {
    return (
      <AccessDenied
        title="Access Forbidden"
        message={error.message || 'You do not have the required permissions to access this resource.'}
        incidentRef={error.digest}
        returnHref="/dashboard"
        returnLabel="Return to Dashboard"
      />
    );
  }

  const copyErrorReport = () => {
    const report = [
      `OpenERP Application Error Report`,
      `Timestamp: ${new Date().toISOString()}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : 'N/A'}`,
      `Message: ${error.message || 'Unknown runtime error'}`,
      error.digest ? `Incident Code: ${error.digest}` : null,
      error.stack ? `Stack:\n${error.stack}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    void navigator.clipboard.writeText(report);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="flex min-h-[75vh] w-full items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-md rounded-3xl border border-border/80 bg-card/85 backdrop-blur-xl p-7 sm:p-8 shadow-2xl relative overflow-hidden text-center space-y-5">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-destructive/50 to-transparent" />

        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive shadow-sm">
          <AlertTriangle className="size-6" />
        </div>

        <div className="space-y-1.5">
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Something went wrong
          </h2>
          <p className="text-xs text-muted-foreground leading-relaxed">
            An unexpected error occurred while rendering this interface. The incident details have been captured for diagnosis.
          </p>
        </div>

        {error.message && (
          <div className="rounded-xl border border-border/80 bg-muted/40 p-3 text-left">
            <div className="text-[11px] font-mono text-muted-foreground break-all line-clamp-3">
              {error.message}
            </div>
            {error.digest && (
              <div className="mt-1 text-[10px] font-mono text-primary">
                Incident Ref: {error.digest}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => reset()}
            className="flex-1 cursor-pointer gap-1.5 text-xs rounded-xl"
          >
            <RefreshCw className="size-3.5" />
            Try Again
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              window.location.href = '/dashboard';
            }}
            className="flex-1 cursor-pointer gap-1.5 text-xs rounded-xl border-border/80"
          >
            <ArrowLeft className="size-3.5" />
            Go to Dashboard
          </Button>
        </div>

        <div>
          <button
            type="button"
            onClick={copyErrorReport}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="size-3.5 text-emerald-500" />
                <span className="text-emerald-500 font-medium">Copied diagnostic report</span>
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                <span>Copy report for system administrator</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
