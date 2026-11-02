'use client';

import { useEffect, useState } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    console.error('Fatal Root Application Error:', error);
  }, [error]);

  const copyErrorReport = () => {
    const report = [
      `OpenERP Fatal Root Error Report`,
      `Timestamp: ${new Date().toISOString()}`,
      `URL: ${typeof window !== 'undefined' ? window.location.href : 'N/A'}`,
      `Message: ${error.message || 'Unknown fatal error'}`,
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
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4 font-sans antialiased">
        <div className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900/90 p-7 sm:p-8 shadow-2xl text-center space-y-5">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-rose-500/10 text-rose-400">
            <svg
              className="size-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>

          <div className="space-y-1.5">
            <h1 className="text-xl font-bold tracking-tight text-white">Application Error</h1>
            <p className="text-xs text-slate-400 leading-relaxed">
              OpenERP encountered an unexpected issue while loading the application shell.
            </p>
          </div>

          {error.message && (
            <div className="rounded-xl border border-slate-800 bg-black/40 p-3 text-left">
              <div className="text-[11px] font-mono text-slate-400 break-all line-clamp-3">
                {error.message}
              </div>
              {error.digest && (
                <div className="mt-1 text-[10px] font-mono text-cyan-400">
                  Incident Ref: {error.digest}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              type="button"
              onClick={() => reset()}
              className="flex-1 py-2 px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-xs shadow-sm transition-colors cursor-pointer"
            >
              Try Again
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = '/login';
              }}
              className="flex-1 py-2 px-3 rounded-xl border border-slate-700 hover:bg-slate-800 text-slate-200 text-xs transition-colors cursor-pointer"
            >
              Back to Sign In
            </button>
          </div>

          <div>
            <button
              type="button"
              onClick={copyErrorReport}
              className="inline-flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
            >
              {copied ? (
                <span className="text-emerald-400 font-medium">Copied diagnostic report</span>
              ) : (
                <span>Copy report for system administrator</span>
              )}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
