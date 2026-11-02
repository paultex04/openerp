'use client';

/**
 * Enterprise Sign-In Portal (Option D: Ambient Glassmorphism & Aurora Mesh Orbs).
 *
 * Implements Option D with Variation 1A (Deep Cobalt & Electric Cyan):
 * - Theme-reactive hardware-accelerated animated Aurora Mesh Orbs.
 * - Dynamic theme tokens: responds immediately to ThemePicker (Harbour, Steel, Ember, Verdant, Midnight).
 * - 3 In-Card Tabs: "Sign In", "Request Access", and "Request Status".
 * - Seamless tab transitions with smooth fade/slide animations.
 * - Self-contained inline Request Status tracker with email lookup.
 * - Cleaned-up card layout with zero redundant text under action buttons.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  Search,
  Send,
  ShieldCheck,
  XCircle,
  Zap,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { DemoAccounts } from '@/components/login/demo-accounts';
import { api, ApiError, type AccessRequestStatusResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

type TabKey = 'signin' | 'request' | 'status';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabKey>('signin');

  // Sign In State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Request Access State
  const [reqFullName, setReqFullName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [reqPhone, setReqPhone] = useState('');
  const [reqDepartment, setReqDepartment] = useState('');
  const [reqReason, setReqReason] = useState('');
  const [reqSuccess, setReqSuccess] = useState<string | null>(null);

  // Request Status State
  const [statusEmailInput, setStatusEmailInput] = useState('');
  const [queriedStatusEmail, setQueriedStatusEmail] = useState<string | null>(null);

  // Forgot Password Dialog State
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);

  // Where to land after signing in.
  const next = safeNext(searchParams.get('next'));

  // Sign-in mutation
  const loginMutation = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/login', { email, password }),
    onSuccess: () => {
      window.location.assign(next);
    },
    onError: (e: Error) => {
      const message =
        e instanceof ApiError ? e.message : 'Could not reach the server. Try again shortly.';
      setError(message);
      setPassword('');
    },
  });

  const submitLogin = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    loginMutation.mutate();
  };

  // Submit request mutation
  const submitRequestMutation = useMutation({
    mutationFn: () =>
      api.post<{ ok: true; id: number; message: string }>('/api/auth/access-requests', {
        fullName: reqFullName,
        email: reqEmail,
        phone: reqPhone || undefined,
        department: reqDepartment,
        reason: reqReason,
      }),
    onSuccess: () => {
      setReqSuccess(reqEmail);
      setError(null);
    },
    onError: (e: Error) => {
      const message =
        e instanceof ApiError
          ? e.message
          : 'Could not submit access request. Please verify your details.';
      setError(message);
    },
  });

  const handleEmbeddedRequest = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!reqFullName.trim() || !reqEmail.trim() || !reqDepartment.trim() || !reqReason.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    submitRequestMutation.mutate();
  };

  // Status lookup query
  const statusQuery = useQuery({
    queryKey: ['inline-access-request-status', queriedStatusEmail],
    queryFn: () =>
      api.get<AccessRequestStatusResponse>('/api/auth/access-requests/status', {
        email: queriedStatusEmail!,
      }),
    enabled: Boolean(queriedStatusEmail),
    staleTime: 10_000,
  });

  const handleStatusSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = statusEmailInput.trim();
    if (!trimmed) {
      setError('Please enter your work email to check request status.');
      return;
    }
    setQueriedStatusEmail(trimmed);
  };

  useEffect(() => {
    document.title = 'Sign in · OpenERP';
  }, []);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center p-4 sm:p-8 overflow-hidden bg-background text-foreground transition-colors duration-300 selection:bg-primary/30">
      {/* CAD Grid Layer (Theme-Reactive) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-grid-cad opacity-50"
      />

      {/* Aurora Mesh Orbs (Theme-Reactive Gradient Spheres) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Orb 1: Primary Accent */}
        <div className="animate-aurora-1 aurora-orb-primary absolute top-1/4 left-1/4 h-[500px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[120px]" />

        {/* Orb 2: Ambient Secondary Accent */}
        <div className="animate-aurora-2 aurora-orb-accent absolute bottom-1/4 right-1/4 h-[450px] w-[450px] translate-x-1/2 translate-y-1/2 rounded-full blur-[110px]" />

        {/* Orb 3: Contextual Info Accent */}
        <div className="animate-aurora-3 aurora-orb-info absolute top-1/2 right-1/3 h-[380px] w-[380px] rounded-full blur-[100px]" />
      </div>

      {/* Top Controls: Theme Switcher */}
      <div className="absolute top-5 right-5 z-30 flex items-center gap-2">
        <ThemePicker />
        <ThemeAnnouncer />
      </div>

      {/* Foreground Authentication Container */}
      <div className="w-full max-w-[440px] relative z-20 space-y-4">
        {/* Option D Frosted Glass Card */}
        <div className="rounded-3xl border border-border/80 bg-card/75 dark:bg-card/65 backdrop-blur-2xl p-7 sm:p-8 shadow-2xl shadow-black/10 dark:shadow-black/60 relative overflow-hidden transition-all duration-300">
          {/* Top Glass Specular Line */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />

          {/* Brand Emblem & Platform Tag */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground font-bold shadow-md shadow-primary/25 transition-colors">
                <Zap className="size-4.5 fill-current" />
              </div>
              <div>
                <span className="font-bold tracking-tight text-foreground text-base">OpenERP</span>
                <span className="text-[10px] font-mono text-muted-foreground ml-1.5">v2.7.0</span>
              </div>
            </div>
            <span className="text-[10px] text-primary border border-primary/30 px-2.5 py-0.5 rounded-full bg-primary/10 font-medium">
              EC&amp;I Platform
            </span>
          </div>

          {/* Card Header Title */}
          <div className="space-y-1 mb-4 min-h-[48px]">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              {activeTab === 'signin' && 'Welcome Back'}
              {activeTab === 'request' && 'Request Access'}
              {activeTab === 'status' && 'Track Status'}
            </h1>
            <p className="text-xs text-muted-foreground">
              {activeTab === 'signin' && 'Sign in to access industrial operations & billing.'}
              {activeTab === 'request' && 'Submit your details for administrator provisioning.'}
              {activeTab === 'status' && 'Query the approval status of your access request.'}
            </p>
          </div>

          {/* In-Card 3-Tab Switcher */}
          <div className="flex rounded-xl bg-muted/70 p-1 border border-border/60 text-xs mb-5 transition-colors">
            {(
              [
                { id: 'signin', label: 'Sign In' },
                { id: 'request', label: 'Request Access' },
                { id: 'status', label: 'Request Status' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveTab(tab.id);
                  setError(null);
                }}
                className={cn(
                  'flex-1 py-1.5 rounded-lg font-medium text-center transition-all duration-200 cursor-pointer text-xs',
                  activeTab === tab.id
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Unified Height Tab Viewport: Card stays exact same size across all tabs */}
          <div className="h-[360px] relative">
            {/* ------------------------------------------------------------- */}
            {/* TAB 1: SIGN IN VIEW                                          */}
            {/* ------------------------------------------------------------- */}
            {activeTab === 'signin' && (
              <div className="h-full flex flex-col justify-between animate-in fade-in duration-200">
                <form
                  onSubmit={submitLogin}
                  className="h-full flex flex-col justify-between"
                  noValidate
                >
                  <div className="space-y-3.5">
                    {/* Session Expired Banner */}
                    {searchParams.get('expired') === '1' && !error && (
                      <Alert
                        role="status"
                        className="border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 text-xs py-2"
                      >
                        <ShieldCheck
                          aria-hidden="true"
                          className="size-3.5 text-amber-600 dark:text-amber-400"
                        />
                        <AlertTitle className="text-xs font-semibold">Session expired</AlertTitle>
                        <AlertDescription className="text-[11px] text-amber-800 dark:text-amber-300/90">
                          Your session has expired. Please sign in again.
                        </AlertDescription>
                      </Alert>
                    )}

                    {/* Sign-in Error Banner */}
                    {error && (
                      <Alert
                        variant="destructive"
                        role="alert"
                        className="text-xs py-2 animate-in fade-in duration-200"
                      >
                        <LogIn aria-hidden="true" className="size-3.5" />
                        <AlertTitle className="text-xs font-semibold">Sign-in failed</AlertTitle>
                        <AlertDescription className="text-[11px]">{error}</AlertDescription>
                      </Alert>
                    )}

                    <Field>
                      <FieldLabel htmlFor="email" className="text-xs font-medium text-foreground">
                        Email Address
                      </FieldLabel>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="username"
                        required
                        autoFocus
                        inputMode="email"
                        placeholder="name@contractor.co.za"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        aria-invalid={error ? true : undefined}
                        className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/20 backdrop-blur-sm h-9"
                      />
                    </Field>

                    <Field>
                      <div className="flex items-center justify-between">
                        <FieldLabel htmlFor="password" className="text-xs font-medium text-foreground">
                          Password
                        </FieldLabel>
                        <button
                          type="button"
                          onClick={() => setForgotPasswordOpen(true)}
                          className="text-[11px] text-primary hover:underline transition-colors cursor-pointer"
                        >
                          Forgot password?
                        </button>
                      </div>
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
                          className="pr-10 rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/20 backdrop-blur-sm h-9"
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

                    <div className="flex items-center gap-2 pt-0.5">
                      <input
                        type="checkbox"
                        id="remember-me"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="rounded border-input bg-background text-primary focus:ring-primary/30 size-3.5 cursor-pointer"
                      />
                      <label
                        htmlFor="remember-me"
                        className="text-xs text-muted-foreground select-none cursor-pointer"
                      >
                        Stay signed in on this device
                      </label>
                    </div>
                  </div>

                  <div className="space-y-3 pt-2">
                    {/* Enterprise Security Badge */}
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground flex items-center gap-2">
                      <ShieldCheck className="size-3.5 text-primary shrink-0" />
                      <span>Enterprise SSO &amp; multi-tenant RBAC enforced.</span>
                    </div>

                    <Button
                      type="submit"
                      size="lg"
                      disabled={loginMutation.isPending}
                      className="w-full py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs shadow-lg shadow-primary/25 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      {loginMutation.isPending ? (
                        <>
                          <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                          Authenticating…
                        </>
                      ) : (
                        <>
                          <span>Continue to Workspace</span>
                          <ArrowRight className="size-3.5" />
                        </>
                      )}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {/* ------------------------------------------------------------- */}
            {/* TAB 2: REQUEST ACCESS VIEW                                    */}
            {/* ------------------------------------------------------------- */}
            {activeTab === 'request' && (
              <div className="h-full flex flex-col justify-between animate-in fade-in duration-200">
                {reqSuccess ? (
                  <div className="h-full flex flex-col justify-between py-1">
                    <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-center flex flex-col items-center justify-center flex-1 space-y-3">
                      <div className="inline-flex size-11 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="size-6" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">Request Submitted</h3>
                        <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-[280px]">
                          Your access request for <strong className="text-foreground">{reqSuccess}</strong> has been routed to system administrators for provisioning.
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setStatusEmailInput(reqSuccess);
                        setQueriedStatusEmail(reqSuccess);
                        setActiveTab('status');
                      }}
                      className="w-full text-xs cursor-pointer border-border/80 hover:bg-muted/60 mt-3 py-2 rounded-xl"
                    >
                      View Status in Tracker →
                    </Button>
                  </div>
                ) : (
                  <form
                    onSubmit={handleEmbeddedRequest}
                    className="h-full flex flex-col justify-between"
                    noValidate
                  >
                    <div className="space-y-2">
                      {/* Request Error Banner */}
                      {error && (
                        <Alert
                          variant="destructive"
                          role="alert"
                          className="text-xs py-1.5 px-3 animate-in fade-in duration-200"
                        >
                          <LogIn aria-hidden="true" className="size-3.5" />
                          <AlertTitle className="text-xs font-semibold">Notice</AlertTitle>
                          <AlertDescription className="text-[11px]">{error}</AlertDescription>
                        </Alert>
                      )}

                      <Field>
                        <FieldLabel htmlFor="req-name" className="text-xs font-medium text-foreground">
                          Full Name *
                        </FieldLabel>
                        <Input
                          id="req-name"
                          required
                          placeholder="e.g. Sipho Sithole"
                          value={reqFullName}
                          onChange={(e) => setReqFullName(e.target.value)}
                          className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring h-8.5"
                        />
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="req-email" className="text-xs font-medium text-foreground">
                          Work Email *
                        </FieldLabel>
                        <Input
                          id="req-email"
                          type="email"
                          required
                          placeholder="sipho@contractor.co.za"
                          value={reqEmail}
                          onChange={(e) => setReqEmail(e.target.value)}
                          className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring h-8.5"
                        />
                      </Field>

                      <div className="grid grid-cols-2 gap-2">
                        <Field>
                          <FieldLabel
                            htmlFor="req-dept"
                            className="text-xs font-medium text-foreground"
                          >
                            Department *
                          </FieldLabel>
                          <Input
                            id="req-dept"
                            required
                            placeholder="Operations"
                            value={reqDepartment}
                            onChange={(e) => setReqDepartment(e.target.value)}
                            className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring h-8.5"
                          />
                        </Field>

                        <Field>
                          <FieldLabel
                            htmlFor="req-phone"
                            className="text-xs font-medium text-foreground"
                          >
                            Phone (Optional)
                          </FieldLabel>
                          <Input
                            id="req-phone"
                            placeholder="+27 82 555 1234"
                            value={reqPhone}
                            onChange={(e) => setReqPhone(e.target.value)}
                            className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring h-8.5"
                          />
                        </Field>
                      </div>

                      <Field>
                        <FieldLabel
                          htmlFor="req-reason"
                          className="text-xs font-medium text-foreground"
                        >
                          Reason for Access *
                        </FieldLabel>
                        <Input
                          id="req-reason"
                          required
                          placeholder="e.g. Site supervisor assigned to Medupi outage"
                          value={reqReason}
                          onChange={(e) => setReqReason(e.target.value)}
                          className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring h-8.5"
                        />
                      </Field>
                    </div>

                    <Button
                      type="submit"
                      size="lg"
                      disabled={submitRequestMutation.isPending}
                      className="w-full py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-xs shadow-lg shadow-primary/25 transition-all flex items-center justify-center gap-1.5 cursor-pointer mt-2"
                    >
                      {submitRequestMutation.isPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Submitting Request…
                        </>
                      ) : (
                        <>
                          <Send className="size-3.5" />
                          Submit Access Request
                        </>
                      )}
                    </Button>
                  </form>
                )}
              </div>
            )}

            {/* ------------------------------------------------------------- */}
            {/* TAB 3: REQUEST STATUS VIEW                                   */}
            {/* ------------------------------------------------------------- */}
            {activeTab === 'status' && (
              <div className="h-full flex flex-col justify-between animate-in fade-in duration-200">
                <div className="h-full flex flex-col justify-between">
                  <form onSubmit={handleStatusSearch} className="space-y-2" noValidate>
                    {error && (
                      <Alert
                        variant="destructive"
                        role="alert"
                        className="text-xs py-1.5 px-3 animate-in fade-in duration-200"
                      >
                        <LogIn aria-hidden="true" className="size-3.5" />
                        <AlertTitle className="text-xs font-semibold">Notice</AlertTitle>
                        <AlertDescription className="text-[11px]">{error}</AlertDescription>
                      </Alert>
                    )}

                    <Field>
                      <FieldLabel
                        htmlFor="status-email"
                        className="text-xs font-medium text-foreground"
                      >
                        Check Request Status By Email
                      </FieldLabel>
                      <div className="flex gap-2">
                        <Input
                          id="status-email"
                          type="email"
                          required
                          placeholder="name@contractor.co.za"
                          value={statusEmailInput}
                          onChange={(e) => setStatusEmailInput(e.target.value)}
                          className="rounded-xl border-input bg-background/80 text-xs text-foreground placeholder:text-muted-foreground focus-visible:border-ring flex-1 h-9"
                        />
                        <Button
                          type="submit"
                          disabled={statusQuery.isFetching}
                          className="px-3.5 rounded-xl bg-primary text-primary-foreground text-xs cursor-pointer gap-1.5 h-9"
                        >
                          {statusQuery.isFetching ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Search className="size-3.5" />
                          )}
                          Check
                        </Button>
                      </div>
                    </Field>
                  </form>

                  {/* Status Display Area */}
                  <div className="flex-1 flex flex-col justify-center pt-2">
                    {!queriedStatusEmail && (
                      <div className="rounded-2xl border border-dashed border-border/80 bg-muted/20 p-5 text-center flex flex-col items-center justify-center h-full space-y-2.5">
                        <div className="size-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                          <Search className="size-5" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-foreground">Track Verification Status</div>
                          <p className="text-[11px] text-muted-foreground max-w-[270px] leading-relaxed mt-1">
                            Enter the work email address used during registration to check if your access request has been reviewed or provisioned.
                          </p>
                        </div>
                      </div>
                    )}

                    {queriedStatusEmail && statusQuery.isSuccess && (
                      <>
                        {!statusQuery.data.found ? (
                          <div className="rounded-2xl border border-border/80 bg-muted/40 p-4 text-center flex flex-col items-center justify-center h-full space-y-2">
                            <AlertCircle className="size-6 text-muted-foreground mx-auto" />
                            <div className="text-xs font-semibold text-foreground">No Request Found</div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed max-w-[280px]">
                              No access request exists for{' '}
                              <span className="font-mono text-foreground">{queriedStatusEmail}</span>. Make sure the
                              spelling is correct, or submit an application under{' '}
                              <strong>Request Access</strong>.
                            </p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setReqEmail(queriedStatusEmail);
                                setActiveTab('request');
                              }}
                              className="text-xs cursor-pointer border-border/80 hover:bg-muted/60 mt-1 rounded-xl"
                            >
                              Submit Access Request →
                            </Button>
                          </div>
                        ) : (
                          statusQuery.data.request && (
                            <div className="rounded-2xl border border-border/80 bg-card/90 p-4 space-y-3 text-xs shadow-sm flex flex-col justify-between h-full">
                              <div>
                                <div className="flex items-start justify-between gap-2">
                                  <div>
                                    <div className="font-semibold text-foreground text-sm">
                                      {statusQuery.data.request.fullName}
                                    </div>
                                    <div className="text-[11px] text-muted-foreground">
                                      {statusQuery.data.request.department || 'Operations'} ·{' '}
                                      {statusQuery.data.request.email}
                                    </div>
                                  </div>

                                  {/* Status Badges */}
                                  {statusQuery.data.request.status === 'Pending' && (
                                    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 gap-1 text-[11px]">
                                      <Clock className="size-3" />
                                      Pending Review
                                    </Badge>
                                  )}
                                  {statusQuery.data.request.status === 'Approved' && (
                                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 gap-1 text-[11px]">
                                      <CheckCircle2 className="size-3" />
                                      Approved
                                    </Badge>
                                  )}
                                  {statusQuery.data.request.status === 'Rejected' && (
                                    <Badge className="bg-destructive/15 text-destructive border-destructive/30 gap-1 text-[11px]">
                                      <XCircle className="size-3" />
                                      Declined
                                    </Badge>
                                  )}
                                </div>

                                {/* Status Description / Admin Notes */}
                                {statusQuery.data.request.status === 'Pending' && (
                                  <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-[11px] text-amber-800 dark:text-amber-300/90 leading-relaxed mt-2.5">
                                    Your application was received on{' '}
                                    <strong>
                                      {new Date(statusQuery.data.request.createdAt).toLocaleDateString()}
                                    </strong>{' '}
                                    and is currently waiting for system administrator approval.
                                  </div>
                                )}

                                {statusQuery.data.request.status === 'Approved' && (
                                  <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-[11px] text-emerald-800 dark:text-emerald-300/90 leading-relaxed mt-2.5">
                                    {statusQuery.data.request.adminNotes ||
                                      'Your account has been approved and provisioned! Please sign in with your credentials.'}
                                  </div>
                                )}

                                {statusQuery.data.request.status === 'Rejected' && (
                                  <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-[11px] text-destructive leading-relaxed mt-2.5">
                                    {statusQuery.data.request.adminNotes ? (
                                      <>
                                        <strong>Feedback:</strong> {statusQuery.data.request.adminNotes}
                                      </>
                                    ) : (
                                      'Your request for access has been reviewed and declined. Please contact your administrator.'
                                    )}
                                  </div>
                                )}
                              </div>

                              {statusQuery.data.request.status === 'Approved' && (
                                <Button
                                  type="button"
                                  onClick={() => {
                                    setEmail(statusQuery.data.request!.email);
                                    setActiveTab('signin');
                                  }}
                                  className="w-full py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs gap-1.5 cursor-pointer shadow-sm mt-2"
                                >
                                  <span>Sign In with {statusQuery.data.request.email}</span>
                                  <ArrowRight className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          )
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Demo Accounts (Development & Test Only) */}
          {process.env.NEXT_PUBLIC_DEMO_LOGIN === '1' && (
            <div className="mt-4 pt-3 border-t border-border/40">
              <DemoAccounts
                onFill={(nextEmail, nextPassword) => {
                  setActiveTab('signin');
                  setEmail(nextEmail);
                  setPassword(nextPassword ?? '');
                  setError(null);
                }}
              />
            </div>
          )}
        </div>

        {/* Security Footnote */}
        <div className="text-center text-[11px] text-muted-foreground flex items-center justify-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            TLS 1.3 Encrypted
          </span>
          <span>•</span>
          <span>Authorized Personnel Only</span>
        </div>
      </div>

      {/* Forgot Password Dialog */}
      <Dialog open={forgotPasswordOpen} onOpenChange={setForgotPasswordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Forgot Password</DialogTitle>
            <DialogDescription>
              Security guidance for account access and password resets.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-xl border border-border/80 bg-muted/40 p-4 text-xs text-muted-foreground space-y-2.5">
            <p>
              OpenERP accounts are managed through corporate role-based security. For security
              reasons, automated public password resets are disabled.
            </p>
            <p>
              Please contact your system administrator or site supervisor to issue a temporary
              password or reset your credentials.
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setForgotPasswordOpen(false)}
              className="cursor-pointer text-xs"
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
