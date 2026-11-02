'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily so server renders do not
  // share mutable state.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Don't retry client errors (4xx: 400 validation, 401 unauth, 403 forbidden, 404 not found, 409 conflict, 422 unprocessable).
            // Only retry network outages (status 0) and transient 5xx server issues.
            retry: (failureCount, error) => {
              const status = (error as { status?: number }).status;
              if (typeof status === 'number' && status >= 400 && status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {children}
        {/*
          One toaster for the whole app. Sits outside the route tree so a toast
          raised by a query that resolves after navigation still survives.
        */}
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
