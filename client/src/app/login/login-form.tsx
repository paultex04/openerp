'use client';

/**
 * Enterprise Sign-In Portal (Option D: Ambient Glassmorphism & Aurora Mesh Orbs).
 *
 * Implements Option D with Variation 1A (Deep Cobalt & Electric Cyan):
 * - Smooth hardware-accelerated animated Aurora Mesh Orbs in the background.
 * - Frosted glassmorphic card with backdrop-blur-2xl and subtle glass border shine.
 * - In-card tab switching between Sign In and Request Access.
 * - Integrated status tracking lookup dialog and demo accounts helper.
 */
import { useMutation } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  LogIn,
  Send,
  ShieldCheck,
  Zap,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { DemoAccounts } from '@/components/login/demo-accounts';
import { RequestAccessDialog } from '@/components/login/request-access-dialog';
import { CheckStatusDialog } from '@/components/login/check-status-dialog';
import { api, ApiError } from '@/lib/api';

export default function LoginForm() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<'signin' | 'request'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Embedded Request Access Form State
  const [reqFullName, setReqFullName] = useState('');
  const [reqEmail, setReqEmail] = useState('');
  const [reqPhone, setReqPhone] = useState('');
  const [reqDepartment, setReqDepartment] = useState('');
  const [reqReason, setReqReason] = useState('');
  const [reqSuccess, setReqSuccess] = useState<string | null>(null);

  // Dialog states for deep dive / status lookup
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  // Where to land after signing in.
  const next = safeNext(searchParams.get('next'));

  const login = useMutation({
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
    login.mutate();
  };

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

  useEffect(() => {
    document.title = 'Sign in · OpenERP';
  }, []);

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center p-4 sm:p-8 overflow-hidden bg-slate-950 text-slate-100 selection:bg-blue-500/30">
      {/* CAD Grid Layer */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-grid-cad opacity-40"
      />

      {/* Aurora Mesh Orbs (Variation 1A: Deep Cobalt & Electric Cyan) */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {/* Deep Cobalt Orb */}
        <div className="animate-aurora-1 absolute top-1/4 left-1/4 h-[480px] w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-tr from-blue-700/40 to-blue-500/35 blur-[120px]" />

        {/* Electric Cyan Accent Orb */}
        <div className="animate-aurora-2 absolute bottom-1/4 right-1/4 h-[440px] w-[440px] translate-x-1/2 translate-y-1/2 rounded-full bg-gradient-to-tr from-cyan-500/35 to-blue-600/30 blur-[110px]" />

        {/* Deep Sapphire Auxiliary Orb */}
        <div className="animate-aurora-3 absolute top-1/2 right-1/3 h-[360px] w-[360px] rounded-full bg-gradient-to-tr from-sky-600/25 to-indigo-700/30 blur-[100px]" />
      </div>

      {/* Top Controls: Theme Switcher */}
      <div className="absolute top-5 right-5 z-30 flex items-center gap-2">
        <ThemePicker />
        <ThemeAnnouncer />
      </div>

      {/* Foreground Container */}
      <div className="w-full max-w-[420px] relative z-20 space-y-4">
        {/* Option D Frosted Glass Card */}
        <div className="rounded-3xl border border-white/15 bg-slate-900/60 backdrop-blur-2xl p-7 sm:p-8 shadow-2xl shadow-black/80 relative overflow-hidden transition-all duration-300">
          {/* Subtle Top Glass Specular Line */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent" />

          {/* Brand Emblem & Platform Tag */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-tr from-blue-500 to-indigo-600 text-white font-bold shadow-md shadow-blue-500/30">
                <Zap className="size-4.5 fill-current" />
              </div>
              <div>
                <span className="font-bold tracking-tight text-white text-base">OpenERP</span>
                <span className="text-[10px] font-mono text-slate-400 ml-1.5">v2.7.0</span>
              </div>
            </div>
            <span className="text-[10px] text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full bg-blue-500/10 font-medium">
              EC&amp;I Platform
            </span>
          </div>

          {/* Card Header */}
          <div className="space-y-1 mb-4">
            <h1 className="text-xl font-bold tracking-tight text-white">
              {activeTab === 'signin' ? 'Welcome Back' : 'Request Access'}
            </h1>
            <p className="text-xs text-slate-400">
              {activeTab === 'signin'
                ? 'Sign in to access industrial operations & billing.'
                : 'Submit your details for administrator provisioning.'}
            </p>
          </div>

          {/* In-Card Tab Switcher */}
          <div className="flex rounded-xl bg-black/40 p-1 border border-white/10 text-xs mb-5">
            <button
              type="button"
              onClick={() => {
                setActiveTab('signin');
                setError(null);
              }}
              className={`flex-1 py-1.5 rounded-lg font-medium text-center transition-all cursor-pointer ${
                activeTab === 'signin'
                  ? 'bg-slate-800/90 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('request');
                setError(null);
              }}
              className={`flex-1 py-1.5 rounded-lg font-medium text-center transition-all cursor-pointer ${
                activeTab === 'request'
                  ? 'bg-slate-800/90 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Request Access
            </button>
          </div>

          {/* Session Expired Banner */}
          {searchParams.get('expired') === '1' && !error && activeTab === 'signin' && (
            <Alert
              role="status"
              className="mb-4 border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs py-2.5"
            >
              <ShieldCheck aria-hidden="true" className="size-4 text-amber-400" />
              <AlertTitle className="text-xs font-semibold">Session expired</AlertTitle>
              <AlertDescription className="text-xs text-amber-300/90">
                Your session has expired. Please sign in again.
              </AlertDescription>
            </Alert>
          )}

          {/* Error Banner */}
          {error && (
            <Alert variant="destructive" role="alert" className="mb-4 text-xs py-2.5">
              <LogIn aria-hidden="true" className="size-4" />
              <AlertTitle className="text-xs font-semibold">
                {activeTab === 'signin' ? 'Sign-in failed' : 'Submission error'}
              </AlertTitle>
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {/* ------------------------------------------------------------- */}
          {/* TAB 1: SIGN IN VIEW                                          */}
          {/* ------------------------------------------------------------- */}
          {activeTab === 'signin' && (
            <form onSubmit={submitLogin} className="space-y-4" noValidate>
              <Field>
                <FieldLabel htmlFor="email" className="text-xs font-medium text-slate-300">
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
                  className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-400/20 backdrop-blur-sm"
                />
              </Field>

              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="password" className="text-xs font-medium text-slate-300">
                    Password
                  </FieldLabel>
                  <a
                    href="#forgot"
                    onClick={(e) => {
                      e.preventDefault();
                      setStatusDialogOpen(true);
                    }}
                    className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    Forgot or pending?
                  </a>
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
                    className="pr-10 rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-blue-400/20 backdrop-blur-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white focus:outline-none transition-colors cursor-pointer"
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
                  className="rounded border-white/20 bg-black/40 text-blue-500 focus:ring-blue-400/30 size-3.5 cursor-pointer"
                />
                <label
                  htmlFor="remember-me"
                  className="text-xs text-slate-400 select-none cursor-pointer"
                >
                  Stay signed in on this device
                </label>
              </div>

              <Button
                type="submit"
                size="lg"
                disabled={login.isPending}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 font-medium text-white text-xs shadow-lg shadow-blue-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {login.isPending ? (
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
            </form>
          )}

          {/* ------------------------------------------------------------- */}
          {/* TAB 2: REQUEST ACCESS VIEW                                    */}
          {/* ------------------------------------------------------------- */}
          {activeTab === 'request' && (
            <div className="space-y-4">
              {reqSuccess ? (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-3">
                  <div className="inline-flex size-10 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 mx-auto">
                    <CheckCircle2 className="size-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">Request Submitted</h3>
                    <p className="text-xs text-slate-300 mt-1">
                      Your request for <strong>{reqSuccess}</strong> has been sent to system
                      administrators for review.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setStatusDialogOpen(true);
                    }}
                    className="w-full text-xs cursor-pointer border-white/20 hover:bg-white/10"
                  >
                    Track Request Status
                  </Button>
                </div>
              ) : (
                <form onSubmit={handleEmbeddedRequest} className="space-y-3" noValidate>
                  <Field>
                    <FieldLabel htmlFor="req-name" className="text-xs font-medium text-slate-300">
                      Full Name *
                    </FieldLabel>
                    <Input
                      id="req-name"
                      required
                      placeholder="e.g. Sipho Sithole"
                      value={reqFullName}
                      onChange={(e) => setReqFullName(e.target.value)}
                      className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400"
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="req-email" className="text-xs font-medium text-slate-300">
                      Work Email *
                    </FieldLabel>
                    <Input
                      id="req-email"
                      type="email"
                      required
                      placeholder="sipho@contractor.co.za"
                      value={reqEmail}
                      onChange={(e) => setReqEmail(e.target.value)}
                      className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400"
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-2">
                    <Field>
                      <FieldLabel htmlFor="req-dept" className="text-xs font-medium text-slate-300">
                        Department *
                      </FieldLabel>
                      <Input
                        id="req-dept"
                        required
                        placeholder="Operations"
                        value={reqDepartment}
                        onChange={(e) => setReqDepartment(e.target.value)}
                        className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400"
                      />
                    </Field>

                    <Field>
                      <FieldLabel
                        htmlFor="req-phone"
                        className="text-xs font-medium text-slate-300"
                      >
                        Phone (Optional)
                      </FieldLabel>
                      <Input
                        id="req-phone"
                        placeholder="+27 82 555 1234"
                        value={reqPhone}
                        onChange={(e) => setReqPhone(e.target.value)}
                        className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400"
                      />
                    </Field>
                  </div>

                  <Field>
                    <FieldLabel htmlFor="req-reason" className="text-xs font-medium text-slate-300">
                      Reason for Access *
                    </FieldLabel>
                    <Input
                      id="req-reason"
                      required
                      placeholder="e.g. Site supervisor assigned to Medupi outage project"
                      value={reqReason}
                      onChange={(e) => setReqReason(e.target.value)}
                      className="rounded-xl border-white/10 bg-black/30 text-xs text-white placeholder:text-slate-500 focus-visible:border-blue-400"
                    />
                  </Field>

                  <Button
                    type="submit"
                    size="lg"
                    disabled={submitRequestMutation.isPending}
                    className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 font-medium text-white text-xs shadow-lg shadow-blue-600/30 transition-all flex items-center justify-center gap-1.5 cursor-pointer mt-1"
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

          {/* Footer Action Links */}
          <div className="pt-4 mt-4 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
            <button
              type="button"
              onClick={() => setStatusDialogOpen(true)}
              className="text-blue-400 hover:text-blue-300 transition-colors cursor-pointer underline-offset-4 hover:underline"
            >
              Check request status
            </button>
            <span className="text-slate-600">•</span>
            <button
              type="button"
              onClick={() => {
                if (activeTab === 'signin') {
                  setActiveTab('request');
                } else {
                  setActiveTab('signin');
                }
              }}
              className="hover:text-slate-200 transition-colors cursor-pointer"
            >
              {activeTab === 'signin'
                ? 'New user? Request access'
                : 'Already have account? Sign in'}
            </button>
          </div>

          {/* Demo Accounts (injected in dev/test only) */}
          <DemoAccounts
            onFill={(nextEmail, nextPassword) => {
              setActiveTab('signin');
              setEmail(nextEmail);
              setPassword(nextPassword ?? '');
              setError(null);
            }}
          />
        </div>

        {/* Security Watermark */}
        <div className="text-center text-[11px] text-slate-500 flex items-center justify-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
            TLS 1.3 Encrypted
          </span>
          <span>•</span>
          <span>Authorized Personnel Only</span>
        </div>
      </div>

      {/* Modal Dialogs */}
      <RequestAccessDialog
        open={requestDialogOpen}
        onOpenChange={setRequestDialogOpen}
        onSwitchToCheckStatus={() => setStatusDialogOpen(true)}
      />

      <CheckStatusDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        onSelectEmail={(selectedEmail) => {
          setActiveTab('signin');
          setEmail(selectedEmail);
        }}
        onSwitchToRequest={() => {
          setActiveTab('request');
        }}
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
