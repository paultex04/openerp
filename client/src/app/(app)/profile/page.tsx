'use client';

/**
 * My Profile — the screen behind the top-right user menu.
 *
 * Three cards, one per thing an account owns: the avatar (an image on the
 * account), the details (login email + the person record jobs are issued
 * under), and the password. Everything here is self-service, so the API gates
 * these endpoints on "signed in" rather than on a catalogue permission — see
 * the note in `server/src/routes/profile.ts` for why that is the safe boundary
 * here.
 *
 * It is deliberately not a DataTable page: there is one of each field and no
 * register to scroll, so the document scrolls and the shell's fixed height
 * chain is left to the pages that need it.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { usePermissions } from '@/components/auth/usePermissions';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import { ApiError, api, apiUpload, type CurrentUser, type ProfileUpdateResponse } from '@/lib/api';
import { avatarImageUrl, avatarTint, initials } from '@/lib/avatar';
import { cn } from '@/lib/utils';

/** Kept in step with the multipart limit in `server/src/routes/profile.ts`. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** The five fields the details form owns, all as strings for the inputs. */
interface ProfileForm {
  email: string;
  name: string;
  surname: string;
  mobile: string;
  personalEmail: string;
}

/** The response as a form state: the server echoes the saved, canonical values. */
function formFromProfile(profile: {
  user: { email: string };
  employee: { name: string; surname: string; mobile: string | null; email: string | null };
}): ProfileForm {
  return {
    email: profile.user.email,
    name: profile.employee.name,
    surname: profile.employee.surname,
    mobile: profile.employee.mobile ?? '',
    personalEmail: profile.employee.email ?? '',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

/** A labelled form row: label, control, and an optional hint under it. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function ProfilePage() {
  const { user } = usePermissions();

  if (!user) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">My Profile</h1>
        </header>
        <p className="text-sm text-muted-foreground">Loading your profile…</p>
      </div>
    );
  }

  // Keyed by account: if the session ever switches user without a reload, the
  // form re-seeds instead of showing the previous person's details.
  return <ProfileForms key={user.user.id} user={user} />;
}

function ProfileForms({ user }: { user: CurrentUser }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);

  /*
   * Seeded once from the session query, then owned by the inputs. Not an effect
   * and not `defaultValue`s: a refetch of `/api/auth/me` (an avatar upload, a
   * save) must not clobber edits in progress, and after a save the inputs must
   * show the canonical values the server echoed back, not what was typed.
   */
  const [form, setForm] = useState<ProfileForm>(() => formFromProfile(user));
  const [password, setPassword] = useState({ current: '', next: '', confirm: '' });
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const avatarUrl = avatarImageUrl(user.user.avatarUpdatedAt);
  const displayName = `${user.employee.name} ${user.employee.surname}`.trim() || user.user.email;

  const save = useMutation({
    mutationFn: (values: ProfileForm) => api.patch<ProfileUpdateResponse>('/api/auth/me', values),
    onSuccess: (result) => {
      setForm(formFromProfile(result));
      toast.add({ title: 'Profile saved', description: result.message, type: 'success' });
      // The user menu reads the same query; it must show the new name at once.
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
    onError: (error) =>
      toast.add({
        title: 'Could not save your profile',
        description: errorMessage(error),
        type: 'error',
      }),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const data = new FormData();
      // The server reads the multipart field named "file" (routes/profile.ts).
      data.append('file', file);
      return apiUpload<{ ok: true; avatarUpdatedAt: string; message: string }>(
        '/api/auth/me/avatar',
        data,
      );
    },
    onSuccess: (result) => {
      toast.add({ title: 'Avatar updated', description: result.message, type: 'success' });
      // New `avatarUpdatedAt` means a new URL: the old image must be replaced.
      void queryClient.invalidateQueries({ queryKey: ['current-user'] });
    },
    onError: (error) =>
      toast.add({
        title: 'Could not update the avatar',
        description: errorMessage(error),
        type: 'error',
      }),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; message: string }>('/api/auth/change-password', {
        currentPassword: password.current,
        newPassword: password.next,
      }),
    onSuccess: (result) => {
      toast.add({ title: 'Password changed', description: result.message, type: 'success' });
      setPassword({ current: '', next: '', confirm: '' });
      // The server cleared the session cookie and bumped the token version:
      // every session, including this one, is intentionally over.
      queryClient.clear();
      router.push('/login');
    },
    onError: (error) => setPasswordError(errorMessage(error)),
  });

  function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so picking the same file again after a failure still fires onChange.
    event.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      toast.add({
        title: 'Unsupported file',
        description: 'Choose a PNG, JPEG or WebP image.',
        type: 'error',
      });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.add({
        title: 'Image too large',
        description: 'Avatars must be 5 MB or smaller.',
        type: 'error',
      });
      return;
    }
    upload.mutate(file);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(form);
  }

  function onChangePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError(null);
    if (password.next !== password.confirm) {
      setPasswordError('The two new passwords do not match.');
      return;
    }
    changePassword.mutate();
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">My Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your sign-in details, your avatar and your password.
        </p>
      </header>

      {/* ---- Avatar ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Avatar</CardTitle>
          <CardDescription>
            Shown beside your name in the top bar. Images are cropped to a square and resized
            automatically, so any landscape or portrait photo will do.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <Avatar className="size-20">
            {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
            <AvatarFallback className={cn('text-xl font-semibold', avatarTint(user.user.email))}>
              {initials(displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="space-y-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              variant="outline"
              disabled={upload.isPending}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending ? 'Uploading…' : 'Upload image'}
            </Button>
            <p className="text-xs text-muted-foreground">PNG, JPEG or WebP, up to 5 MB.</p>
          </div>
        </CardContent>
      </Card>

      {/* ---- Details ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your details</CardTitle>
          <CardDescription>
            Your sign-in address, and the person record your jobs and documents are issued under.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <Field id="profile-email" label="Login email" hint="Used to sign in. Must be unique.">
              <Input
                id="profile-email"
                type="email"
                autoComplete="username"
                required
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="profile-name" label="Name">
                <Input
                  id="profile-name"
                  autoComplete="given-name"
                  required
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </Field>
              <Field id="profile-surname" label="Surname">
                <Input
                  id="profile-surname"
                  autoComplete="family-name"
                  required
                  value={form.surname}
                  onChange={(event) => setForm({ ...form, surname: event.target.value })}
                />
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="profile-mobile" label="Mobile">
                <Input
                  id="profile-mobile"
                  type="tel"
                  autoComplete="tel"
                  value={form.mobile}
                  onChange={(event) => setForm({ ...form, mobile: event.target.value })}
                />
              </Field>
              <Field
                id="profile-personal-email"
                label="Personal email"
                hint="Separate from your login email."
              >
                <Input
                  id="profile-personal-email"
                  type="email"
                  autoComplete="email"
                  value={form.personalEmail}
                  onChange={(event) => setForm({ ...form, personalEmail: event.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ---- Password ---- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Password</CardTitle>
          <CardDescription>
            Changing your password signs out every device, including this one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onChangePassword}>
            <Field id="current-password" label="Current password">
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                required
                value={password.current}
                onChange={(event) => setPassword({ ...password, current: event.target.value })}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="new-password" label="New password">
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password.next}
                  onChange={(event) => setPassword({ ...password, next: event.target.value })}
                />
              </Field>
              <Field id="confirm-password" label="Confirm new password">
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password.confirm}
                  onChange={(event) => setPassword({ ...password, confirm: event.target.value })}
                />
              </Field>
            </div>

            {passwordError && (
              <p role="alert" className="text-sm text-negative">
                {passwordError}
              </p>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                disabled={
                  changePassword.isPending ||
                  !password.current ||
                  !password.next ||
                  !password.confirm
                }
              >
                {changePassword.isPending ? 'Changing…' : 'Change password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
