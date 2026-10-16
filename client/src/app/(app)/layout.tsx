import { AppShell } from '@/components/app-shell';
import { ChatGate } from '@/components/chat/chat-gate';
import { Spinner } from '@/components/ui/spinner';
import type { ReactNode } from 'react';
import { Suspense } from 'react';

/**
 * Layout for the authenticated area.
 *
 * A route group, so `/commercial`, `/operations` and friends keep their URLs
 * while sharing one shell. Moving the shell here rather than into each page is
 * what stops the five screens each growing their own header and navigation.
 *
 * The shell itself resolves the session, so this file stays a pass-through. The
 * middleware already 302s unauthenticated visitors to `/login`; this layer only
 * has to make sure a rendered frame exists for them.
 *
 * The Suspense boundary is load-bearing. Pages read their tab and filters from
 * the URL (`?tab=rates`) so the sidebar can deep-link into them, and
 * `useSearchParams` opts a client component out of static prerendering - Next
 * fails the build without a boundary. It is declared once here rather than in
 * each page, because every page needs it and the requirement is identical.
 */
export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  return (
    <ChatGate>
      <AppShell>
        <Suspense
          fallback={
            <div className="flex min-h-64 items-center justify-center">
              <Spinner className="size-6 text-muted-foreground" />
              <span className="sr-only">Loading…</span>
            </div>
          }
        >
          {children}
        </Suspense>
      </AppShell>
    </ChatGate>
  );
}
