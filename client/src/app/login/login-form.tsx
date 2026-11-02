'use client';

/**
 * Enterprise Sign-In Portal.
 *
 * Provides a clean, focused, professional authentication interface.
 * The session lives entirely in an HTTP-only cookie, so this form performs no
 * token handling at all — it posts credentials, the API sets the cookie, and the
 * cookie rides along on subsequent same-origin requests.
 */
import { useMutation } from '@tanstack/react-query';
import {
  Calculator,
  Eye,
  EyeOff,
  Layers,
  Loader2,
  LogIn,
  Receipt,
  ShieldCheck,
} from 'lucide-react';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { DemoAccounts } from '@/components/login/demo-accounts';
import { RequestAccessDialog } from '@/components/login/request-access-dialog';
import { CheckStatusDialog } from '@/components/login/check-status-dialog';
import { api, ApiError } from '@/lib/api';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  // Where to land after signing in. Preserved so a user bounced
  // off a deep link reaches the page they actually asked for.
  const next = safeNext(searchParams.get('next'));

  const login = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/login', { email, password }),
    onSuccess: () => {
      // Full navigation so the server and proxy re-evaluate the session
      window.location.assign(next);
    },
    onError: (e: Error) => {
      const message =
        e instanceof ApiError ? e.message : 'Could not reach the server. Try again shortly.';
      setError(message);
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
    <main className="relative grid min-h-screen lg:grid-cols-2">
      {/* Brand Hero Panel (Desktop) */}
      <aside
        aria-hidden="true"
        className="relative hidden flex-col justify-between overflow-hidden bg-primary p-12 text-primary-foreground lg:flex"
      >
        {/* Radial wash background */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(60rem 40rem at 15% -10%, color-mix(in oklch, var(--primary-foreground) 16%, transparent), transparent 60%), radial-gradient(40rem 30rem at 90% 110%, color-mix(in oklch, var(--primary-foreground) 10%, transparent), transparent 60%)',
          }}
        />

        {/* Brand Lockup */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary-foreground text-base font-bold text-primary shadow-sm">
            OE
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold tracking-tight">OpenERP</span>
              <span className="rounded-full bg-primary-foreground/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
                Enterprise
              </span>
            </div>
            <p className="text-xs text-primary-foreground/70">EC&amp;I Contracting Platform</p>
          </div>
        </div>

        {/* Core Value Pillars */}
        <div className="relative z-10 max-w-lg space-y-6">
          <div className="space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-balance leading-tight">
              Precision engineering from estimate to invoice.
            </h1>
            <p className="text-sm leading-relaxed text-primary-foreground/80 text-pretty">
              Unified project lifecycle, commercial rate buildup, site tracking, and automated
              financial billing.
            </p>
          </div>

          <div className="space-y-3 pt-2">
            <div className="flex items-start gap-3 rounded-xl bg-primary-foreground/10 p-3.5 backdrop-blur-xs border border-primary-foreground/10">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                <Calculator className="size-4 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-xs font-semibold">Commercial &amp; Estimating</h3>
                <p className="text-xs text-primary-foreground/75 leading-relaxed">
                  Dynamic service code recipes, labor tariffs, and live margin modeling.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl bg-primary-foreground/10 p-3.5 backdrop-blur-xs border border-primary-foreground/10">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                <Layers className="size-4 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-xs font-semibold">Job Lifecycle &amp; Operations</h3>
                <p className="text-xs text-primary-foreground/75 leading-relaxed">
                  Live site progress, variation orders, and quality milestone tracking.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl bg-primary-foreground/10 p-3.5 backdrop-blur-xs border border-primary-foreground/10">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                <Receipt className="size-4 text-primary-foreground" />
              </div>
              <div>
                <h3 className="text-xs font-semibold">Automated Billing &amp; Matrix</h3>
                <p className="text-xs text-primary-foreground/75 leading-relaxed">
                  Crew timesheets, multi-tier approvals, and verified SARS VAT invoicing.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="relative z-10 flex items-center justify-between text-xs text-primary-foreground/60">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-4" />
            <span>Enterprise security &amp; role-based access control</span>
          </div>
          <span>v2.1</span>
        </div>
      </aside>

      {/* Form Viewport */}
      <div className="relative flex min-h-screen items-center justify-center p-6 sm:p-10">
        {/* Subtle Theme Controls in Top-Right */}
        <div className="absolute top-5 right-5 z-20 flex items-center gap-2">
          <ThemePicker />
          <ThemeAnnouncer />
        </div>

        <Card className="w-full max-w-sm border-border/60 shadow-xl shadow-black/5 dark:shadow-black/20">
          <CardHeader className="space-y-1.5 pb-4">
            {/* Mobile Brand Emblem (hidden on desktop where hero aside is visible) */}
            <div className="mb-2 flex items-center gap-2 lg:hidden">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
                OE
              </div>
              <span className="text-base font-bold">OpenERP</span>
            </div>
            <CardTitle className="text-xl font-bold tracking-tight">Sign in</CardTitle>
            <CardDescription>Enter your credentials to access your workspace.</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={submit} className="space-y-4" noValidate>
              {searchParams.get('expired') === '1' && !error && (
                <Alert
                  role="status"
                  className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                >
                  <ShieldCheck
                    aria-hidden="true"
                    className="size-4 text-amber-600 dark:text-amber-400"
                  />
                  <AlertTitle>Session expired</AlertTitle>
                  <AlertDescription>
                    Your session has expired. Please sign in again.
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive" role="alert">
                  <LogIn aria-hidden="true" className="size-4" />
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  autoFocus
                  inputMode="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={error ? true : undefined}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <div className="relative">
                  <Input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    placeholder="••••••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none transition-colors cursor-pointer"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </Field>

              <Button
                type="submit"
                size="lg"
                className="w-full font-medium h-10 cursor-pointer"
                disabled={login.isPending}
              >
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

              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 px-1">
                <button
                  type="button"
                  onClick={() => setRequestDialogOpen(true)}
                  className="hover:text-primary transition-colors cursor-pointer underline-offset-4 hover:underline"
                >
                  Request access
                </button>
                <span className="text-muted-foreground/30">•</span>
                <button
                  type="button"
                  onClick={() => setStatusDialogOpen(true)}
                  className="hover:text-primary transition-colors cursor-pointer underline-offset-4 hover:underline"
                >
                  Check request status
                </button>
              </div>
            </form>
          </CardContent>

          <CardFooter className="flex-col items-stretch gap-4 pt-0">
            <DemoAccounts
              onFill={(nextEmail, nextPassword) => {
                setEmail(nextEmail);
                setPassword(nextPassword ?? '');
                setError(null);
              }}
            />
            <div className="flex items-center justify-center gap-1.5 pt-2 text-xs text-muted-foreground/75">
              <ShieldCheck className="size-3.5 text-muted-foreground" />
              <span>Authorized personnel only</span>
            </div>
          </CardFooter>
        </Card>
      </div>

      <RequestAccessDialog
        open={requestDialogOpen}
        onOpenChange={setRequestDialogOpen}
        onSwitchToCheckStatus={() => setStatusDialogOpen(true)}
      />

      <CheckStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        onSelectEmail={(selectedEmail) => setEmail(selectedEmail)}
        onSwitchToRequest={() => setRequestDialogOpen(true)}
      />
    </main>
  );
}

/**
 * Validates a `next` redirect target.
 */
function safeNext(raw: string | null): string {
  if (!raw) return '/dashboard';
  if (!raw.startsWith('/')) return '/dashboard';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/dashboard';
  return raw;
}
