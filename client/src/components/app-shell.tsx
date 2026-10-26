'use client';

/**
 * Enterprise application shell.
 *
 * Replaces the five bespoke `<header>` + `<nav>` blocks the pages each carried,
 * which is the reason the app previously felt like five unrelated tools sharing
 * one database.
 *
 * Layout contract:
 *   sidebar (collapsible to icons, persisted) | inset = breadcrumb bar + content
 *
 * Authorisation: the sidebar mirrors what the API will allow, using the same
 * permission catalogue. It is a courtesy, not a boundary - hiding a link does
 * not protect the route, and the API still refuses every call independently.
 *
 * NOTE ON BASE UI: this project uses the `base-nova` shadcn base, so components
 * take a `render` prop rather than Radix's `asChild`. See ADR-006.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { Suspense } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SidebarInset,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { usePermissions } from '@/components/auth/usePermissions';
import { useSessionRefresh } from '@/hooks/use-session-refresh';
import { ChatDock, ChatToggle } from '@/components/chat/chat-dock';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { QuickThemeToggle } from '@/components/theme-toggle';
import { CommandPalette } from '@/components/command-palette';
import { NotificationCenter } from '@/components/notifications/notification-center';
import { DualRailProvider } from '@/lib/nav-store';
import { DualRailSidebar, DualRailTrigger } from '@/components/navigation/DualRailSidebar';
import { api } from '@/lib/api';
import { avatarImageUrl, avatarTint, initials } from '@/lib/avatar';
import { breadcrumbFor } from '@/lib/nav';
import { useSidebarOpen } from '@/lib/shell-preferences';
import { cn } from '@/lib/utils';

/** `commercial_qs` -> "Commercial QS"; acronyms stay uppercase. */
function humanise(roles: readonly string[]): string {
  if (roles.length === 0) return 'No roles assigned';
  const ACRONYMS = new Set(['qs', 'ecn', 'ie']);
  return roles
    .map((role) =>
      role
        .split('_')
        .map((part) =>
          ACRONYMS.has(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
        )
        .join(' '),
    )
    .join(', ');
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useSessionRefresh();
  const { user, loading } = usePermissions();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();

  const logout = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout'),
    onSuccess: () => {
      queryClient.clear();
      router.push('/login');
      router.refresh();
    },
    onError: () =>
      toast.add({
        title: 'Sign-out request failed',
        description: 'Continuing anyway. Close the browser if this is a shared machine.',
        type: 'warning',
      }),
  });

  return (
    <DualRailProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        className="h-dvh overflow-hidden flex flex-row"
      >
        <DualRailSidebar />

        <SidebarInset id="main-content" className="min-w-0 overflow-hidden flex-1">
          <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75">
            <DualRailTrigger className="-ml-1" />

            <Suspense fallback={<Skeleton className="h-4 w-40" />}>
              <BreadcrumbTrail />
            </Suspense>

            <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
              {loading && <Spinner className="size-4 text-muted-foreground" />}
              <CommandPalette />
              <NotificationCenter />
              <ChatToggle />
              <QuickThemeToggle />
              <ThemePicker />
              <ThemeAnnouncer />
              <UserMenu
                email={user?.user.email}
                displayName={
                  user?.employee ? `${user.employee.name} ${user.employee.surname}`.trim() : undefined
                }
                avatarUrl={avatarImageUrl(user?.user.avatarUpdatedAt)}
                roles={user?.roles.map((role) => role.key) ?? []}
                loggingOut={logout.isPending}
                onLogout={() => logout.mutate()}
              />
            </div>
          </header>

          <div id="main-scroll-container" className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex h-full flex-col p-4 sm:p-6">
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
            </div>
          </div>
        </SidebarInset>

        <ChatDock />
      </SidebarProvider>
    </DualRailProvider>
  );
}

/**
 * Breadcrumb trail for the current URL.
 *
 * Isolated in its own component so the single `useSearchParams()` call is
 * enclosed by the shell's Suspense boundary. Reading the hook in `AppShell`
 * itself would opt the whole shell out of prerendering and fail the build.
 */
function BreadcrumbTrail() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const trail = breadcrumbFor(pathname, search);
  const jobId = pathname.match(/^\/operations\/(\d+)$/)?.[1];

  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          {trail ? (
            <>
              <BreadcrumbLink render={<Link href="/dashboard" />}>OpenERP</BreadcrumbLink>
              <span aria-hidden="true" className="mx-1 text-muted-foreground">
                /
              </span>
              <BreadcrumbPage>
                {jobId ? `${trail.item.label} · Job #${jobId}` : trail.item.label}
              </BreadcrumbPage>
            </>
          ) : (
            <BreadcrumbPage>OpenERP</BreadcrumbPage>
          )}
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function UserMenu({
  email,
  displayName,
  avatarUrl,
  roles,
  loggingOut,
  onLogout,
}: {
  email: string | undefined;
  displayName: string | undefined;
  /** undefined renders the initials fallback - the account has no avatar. */
  avatarUrl: string | undefined;
  roles: readonly string[];
  loggingOut: boolean;
  onLogout: () => void;
}) {
  const tint = avatarTint(email);
  // Prefer the person's name; fall back to the address when no employee record is
  // linked. Never render both in the trigger - it is too long for the header.
  const label = displayName || email || 'Signed in';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="sm" className="h-9 gap-2 px-2">
            <Avatar className="size-7">
              {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
              <AvatarFallback className={cn('text-[11px] font-semibold', tint)}>
                {initials(displayName || email)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">{label}</span>
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        {/*
          `DropdownMenuGroup` is mandatory here, not decorative. In the base-nova
          component `DropdownMenuLabel` wraps Base UI's `MenuGroupLabel`, which
          throws "MenuGroupContext is missing" unless it is inside a menu group.
          Rendering the label on its own crashed the whole tree, and it did so only
          on click - the page looked perfectly healthy until the menu opened.
        */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-1">
            <span className="truncate text-sm font-medium">{label}</span>
            {email && email !== label && (
              <span className="truncate text-xs font-normal text-muted-foreground">{email}</span>
            )}
            <span className="text-xs font-normal text-muted-foreground">{humanise(roles)}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href="/profile" />}>
          <UserRound aria-hidden="true" />
          My Profile
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" disabled={loggingOut} onClick={onLogout}>
          {loggingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
