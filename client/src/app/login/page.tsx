'use client';

/**
 * Sign-in page.
 *
 * The session lives entirely in an HTTP-only cookie, so this form performs no
 * token handling at all — it posts credentials, the API sets the cookie, and the
 * cookie rides along on subsequent same-origin requests via the Next.js rewrite.
 * That is the whole point of the cookie approach: page scripts can never read the
 * session token, so an XSS bug cannot exfiltrate it.
 */
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/login', { email, password }),
    onSuccess: () => {
      // Full navigation so the server-rendered shell re-reads the new session.
      router.push('/');
      router.refresh();
    },
    onError: (e: Error) =>
      toast({
        title: 'Sign-in failed',
        description: e instanceof ApiError ? e.message : 'Unexpected error.',
        variant: 'destructive',
      }),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">OpenERP</h1>
          <p className="text-sm text-muted-foreground">Sign in to continue.</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-lg border p-6">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Email address</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@contractor.co.za"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>

          <Button type="submit" className="w-full" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground">
          The session is issued as an HTTP-only cookie and is never exposed to page scripts.
        </p>
      </div>
    </main>
  );
}
