import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner';
import LoginForm from './login-form';

export const metadata: Metadata = {
  title: 'Sign in · OpenERP',
  description: 'Sign in to OpenERP.',
};

/**
 * `/login` is deliberately outside the `(app)` route group: it must render
 * without the authenticated shell, sidebar or session lookup.
 *
 * The Suspense boundary is required, not cosmetic. `LoginForm` reads
 * `useSearchParams()` to honour the `next` redirect, and Next.js cannot
 * prerender a client component that reads search params without one - the build
 * fails with a bail-out error otherwise.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
          <span className="sr-only">Loading sign-in…</span>
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
