'use client';

/**
 * Sign-in form.
 *
 * The session lives entirely in an HTTP-only cookie, so this form performs no
 * token handling at all - it posts credentials, the API sets the cookie, and the
 * cookie rides along on subsequent same-origin requests via the Next.js proxy.
 * That is the whole point of the cookie approach: page scripts can never read
 * the session token, so an XSS bug cannot exfiltrate it.
 *
 * After success we navigate rather than relying on a client-side redirect so the
 * middleware sees the new cookie and routes to `/dashboard`.
 */
import { useMutation } from '@tanstack/react-query';
import { Loader2, LogIn, ShieldCheck } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { DemoAccounts } from '@/components/login/demo-accounts';
import { api, ApiError } from '@/lib/api';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Where to land after signing in. Preserved by the middleware so a user bounced
  // off a deep link reaches the page they actually asked for. Validated against a
  // fixed shape below: an unchecked value from the query string is attacker
  // controlled, and redirecting to it verbatim is an open redirect.
  const next = safeNext(searchParams.get('next'));

  const login = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/login', { email, password }),
    onSuccess: () => {
      // A full navigation, so the server and middleware re-evaluate the session
      // rather than the router carrying a stale view forward.
      window.location.assign(next);
    },
    onError: (e: Error) => {
      const message =
        e instanceof ApiError ? e.message : 'Could not reach the server. Try again shortly.';
      setError(message);
      // A wrong password is not worth echoing back, and the field is cleared so
      // the next attempt starts from a known state.
      setPassword('');
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    login.mutate();
  };

  useEffect(() => {
    document.title = 'Sign in · OpenERP';
  }, []);

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      {/*
        Brand panel. Hidden on small screens where it would push the form below
        the fold, and marked aria-hidden because it carries no information the
        form does not.
      */}
      <aside
        aria-hidden="true"
        /*
          Tinted with `--primary` rather than a literal `bg-slate-900`, so the
          sign-in screen is themed too. It used to be a fixed dark panel with a
          cyan wash, which meant signing in under Midnight showed two unrelated
          dark surfaces side by side and the accent appeared nowhere.
        */
        className="relative hidden flex-col justify-between overflow-hidden bg-primary p-10 text-primary-foreground lg:flex"
      >
        {/*
          A wash of the same hue, one step lighter, using an alpha of the panel's
          own foreground. `color-mix` keeps it tied to the active theme; the
          previous hardcoded `rgb(14 165 233 / 0.28)` could not follow a theme
          because it named a colour rather than a relationship.
        */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60rem 40rem at 15% -10%, color-mix(in oklch, var(--primary-foreground) 16%, transparent), transparent 60%), radial-gradient(40rem 30rem at 90% 110%, color-mix(in oklch, var(--primary-foreground) 10%, transparent), transparent 60%)',
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary-foreground text-sm font-bold text-primary">
              OE
            </div>
            <div>
              <p className="text-base font-semibold">OpenERP</p>
              <p className="text-xs text-primary-foreground/70">EC&amp;I Contracting</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-md space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Contracts to cash, in one system of record.
          </h2>
          <p className="text-sm leading-relaxed text-primary-foreground/75">
            Rate-card build-up, job lifecycle, field actuals and invoice status are all governed by
            the same rules the API enforces — the interface shows the same state machine, so a
            control is never offered that the server would refuse.
          </p>
        </div>

        <p className="relative flex items-center gap-2 text-xs text-primary-foreground/60">
          <ShieldCheck aria-hidden="true" className="size-4" />
          Sessions are held in HTTP-only cookies and never exposed to page scripts.
        </p>
      </aside>

      <div className="flex items-center justify-center p-6 sm:p-10">
        <Card className="w-full max-w-sm">
          <CardHeader className="space-y-1.5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex size-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
                  OE
                </div>
                <p className="text-sm font-semibold">OpenERP</p>
              </div>
              {/*
                The picker is here as well as in the app shell. Appearance is a
                per-device preference, and someone who wants a dark theme should
                not have to sign in to get one - the first screen they see should
                already be the one they want.
              */}
              <ThemePicker />
              <ThemeAnnouncer />
            </div>
            <CardTitle className="text-xl">Sign in</CardTitle>
            <CardDescription>Use your OpenERP account to continue · Homelab</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={submit} className="space-y-4" noValidate>
              {/*
                Errors are surfaced in an Alert with role="alert" (assertive), not
                only as red text: a colour change alone conveys nothing to a
                screen-reader user, and this is the one message on the page that
                must interrupt.
              */}
              {error && (
                <Alert variant="destructive" role="alert">
                  <LogIn aria-hidden="true" className="size-4" />
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Field>
                <FieldLabel htmlFor="email">Email address</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  inputMode="email"
                  placeholder="you@contractor.co.za"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={error ? true : undefined}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error ? true : undefined}
                />
                <FieldDescription>At least 12 characters.</FieldDescription>
              </Field>

              <Button type="submit" className="w-full" disabled={login.isPending}>
                {login.isPending ? (
                  <>
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                    Signing in…
                  </>
                ) : (
                  <>
                    <LogIn aria-hidden="true" className="size-4" />
                    Sign in
                  </>
                )}
              </Button>
            </form>
          </CardContent>

          <CardFooter className="flex-col items-stretch gap-4">
            {/*
              Development shortcuts, rendered above the role explanation because
              when they exist they are the reason someone is on this page. The
              component returns null unless NEXT_PUBLIC_DEMO_LOGIN=1, so this
              costs nothing in a normal build.
            */}
            <DemoAccounts
              onFill={(nextEmail, nextPassword) => {
                setEmail(nextEmail);
                setPassword(nextPassword ?? '');
                setError(null);
              }}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              Access is role-based. If a section is missing after signing in, your roles do not
              grant it — ask an administrator.
            </p>
          </CardFooter>
        </Card>
      </div>
    </main>
  );
}

/**
 * Validates a `next` target.
 *
 * Only same-origin absolute paths are allowed. Rejecting `//evil.test` and
 * `https://evil.test` matters: an unvalidated query parameter turned into a
 * redirect is an open redirect that survives link scanners.
 */
function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/')) return '/dashboard';
  // `//host` and `/\host` are protocol-relative URLs, not local paths.
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}
