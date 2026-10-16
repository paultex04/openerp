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
import { ChevronDown, Gauge, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useMemo } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { usePermissions } from '@/components/auth/usePermissions';
import { ThemeAnnouncer, ThemePicker } from '@/components/theme-picker';
import { api } from '@/lib/api';
import { avatarImageUrl, avatarTint, initials } from '@/lib/avatar';
import { breadcrumbFor, visibleSections, type NavSection } from '@/lib/nav';
import { useCollapsedSections, useSidebarOpen } from '@/lib/shell-preferences';
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

/**
 * True when every query filter named by `href` is present and equal in `search`.
 *
 * This is what stops "Contracts & Amendments" and "Cost Parameters" - the same
 * path, a different `tab` - from both lighting up as active.
 */
function filtersMatch(href: string, search: string): boolean {
  const [, query] = href.split('?');
  if (!query) return true;
  const current = new URLSearchParams(search);
  for (const [key, value] of new URLSearchParams(query)) {
    if (current.get(key) !== value) return false;
  }
  return true;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, permissions, loading } = usePermissions();
  const sections = useMemo(() => visibleSections(permissions), [permissions]);
  const router = useRouter();
  const queryClient = useQueryClient();

  /*
   * Both persisted values are read through `useSyncExternalStore` rather than
   * seeded in an effect: they exist before React does, and seeding them in an
   * effect would cascade an extra render on every mount and let the rail snap
   * into place after first paint. See `lib/shell-preferences.ts`.
   */
  const [sidebarOpen, setSidebarOpen] = useSidebarOpen();
  const [collapsed, toggleSection] = useCollapsedSections();

  const logout = useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout'),
    onSuccess: () => {
      // Clear before leaving: otherwise the next person at this machine sees the
      // previous session's data flash past while queries revalidate.
      queryClient.clear();
      router.push('/login');
      router.refresh();
    },
    onError: () =>
      // The cookie is cleared server-side regardless. A failed call must not
      // strand the user in a half-signed-out state.
      toast.add({
        title: 'Sign-out request failed',
        description: 'Continuing anyway. Close the browser if this is a shared machine.',
        type: 'warning',
      }),
  });

  return (
    /*
     * `h-dvh overflow-hidden` is what makes "fill the screen" possible at all.
     *
     * shadcn's SidebarProvider sets only `min-h-svh`, a *minimum*. A flex child
     * under a minimum-height parent still sizes to its content, so every
     * `flex-1` below it collapses to zero and a filling table ends up with no
     * height at all. A definite height lets `SidebarInset` take the remainder and
     * the page's `flex-1` resolve to real pixels.
     */
    <SidebarProvider
      open={sidebarOpen}
      onOpenChange={setSidebarOpen}
      className="h-dvh overflow-hidden"
    >
      <AppSidebar
        sections={sections}
        collapsed={collapsed}
        onToggleSection={toggleSection}
        loading={loading}
      />

      {/*
        `SidebarInset` already renders a <main>. Wrapping the page in another
        one produced two main landmarks - a real accessibility defect, since the
        main landmark is what a screen-reader user jumps to and a duplicate makes
        that target ambiguous. The id therefore lives on SidebarInset, which is
        the element that actually *is* the landmark.
      */}
      <SidebarInset id="main-content" className="min-w-0 overflow-hidden">
        {/*
          The shell is a fixed-height flex chain so a page can fill the viewport
          exactly: viewport = header + content, and the content area is the only
          thing that scrolls.

          The `min-h-0` on the content wrapper is load-bearing. In a flex column a
          child defaults to `min-height: auto`, which refuses to shrink below its
          content - so a long table would push the page taller than the screen
          and the shell would scroll as a whole, taking the sticky header with it
          and leaving the table's own scroll region redundant.
        */}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75">
          <SidebarTrigger className="-ml-1" />

          {/*
            The breadcrumb resolves against the query string, so it must sit
            below its own Suspense boundary - `useSearchParams` opts a client
            component out of static prerendering and Next fails the build
            otherwise. Scoping the boundary this narrowly keeps the header,
            sidebar chrome and user menu painting immediately instead of
            replacing the whole shell with a spinner.
          */}
          <Suspense fallback={<Skeleton className="h-4 w-40" />}>
            <BreadcrumbTrail />
          </Suspense>

          <div className="ml-auto flex items-center gap-2">
            {loading && <Spinner className="size-4 text-muted-foreground" />}
            {/*
              Theme is a per-device preference, so it is offered to every
              authenticated user rather than gated on a permission.
            */}
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
          {/*
            `h-full`, not `min-h-full`. The inner wrapper must be exactly the
            scroll container's height so a page's `flex-1` child resolves against
            a definite box; `min-h-full` lets the box grow with content, which
            reintroduces the indefinite height the chain is trying to avoid.
          */}
          <div className="flex h-full flex-col p-4 sm:p-6">
            {/*
            Pages read their tab and filters from the URL, so each of them needs
            this boundary too. The layout declares the same one for the page
            itself; this one exists because AppShell renders above the layout's
            boundary and must not opt itself out of prerendering.
          */}
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
    </SidebarProvider>
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
              {/*
                A literal separator rather than BreadcrumbSeparator: that
                component carries its own accessible role, and nesting a
                decorative glyph between two items is what it is for.
              */}
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

/** Placeholder rows while the real navigation resolves. */
function SidebarMenuSkeletonList() {
  return (
    <SidebarMenu>
      {[0, 1, 2].map((row) => (
        <SidebarMenuItem key={row}>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/**
 * The permission-filtered navigation list.
 *
 * Separated from `AppSidebar` so the one `useSearchParams()` call it needs sits
 * under a Suspense boundary: a hook read higher up would opt the entire shell
 * out of static prerendering and Next would fail the build on every route.
 */
function NavSectionList({
  sections,
  collapsed,
  onToggleSection,
  loading,
}: {
  sections: NavSection[];
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  loading: boolean;
}) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { open } = useSidebar();

  if (loading && sections.length === 0) {
    return <p className="px-2 py-3 text-xs text-muted-foreground">Loading navigation…</p>;
  }

  if (!loading && sections.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        Your roles grant no navigation. Contact an administrator.
      </p>
    );
  }

  return (
    <>
      {sections.map((section) => {
        const isCollapsed = collapsed.has(section.key);
        return (
          // Controlled: `open` comes from persisted state, and the trigger's
          // own toggle is routed back through `onOpenChange` so the two cannot
          // disagree. Without that, the disclosure animates but never persists.
          <Collapsible
            key={section.key}
            open={!isCollapsed}
            onOpenChange={() => onToggleSection(section.key)}
          >
            <SidebarGroup>
              {/*
                A real button, not a styled div: this is a disclosure control
                and must be reachable and operable from the keyboard. shadcn's
                SidebarGroupLabel renders a div, so the trigger carries the
                label's styling itself.
              */}
              <CollapsibleTrigger
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-md px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase',
                  'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  !open && 'justify-center',
                )}
                aria-label={open ? section.label : undefined}
              >
                <section.icon aria-hidden="true" className="size-4 shrink-0" />
                {open && (
                  <>
                    <span className="truncate">{section.label}</span>
                    <ChevronDown
                      aria-hidden="true"
                      className={cn(
                        'ml-auto size-3.5 shrink-0 transition-transform duration-200',
                        isCollapsed && '-rotate-90',
                      )}
                    />
                  </>
                )}
              </CollapsibleTrigger>
            </SidebarGroup>

            <CollapsibleContent>
              {/*
                The indent, and why it is here rather than on the button.

                `SidebarMenu` ships `p-2` and `SidebarMenuButton` ships `p-2` with
                a 16px icon and a `gap-2`. The section header is `px-2` with its own
                16px icon and the same gap. Both labels therefore began at exactly
                2rem from the sidebar edge - identical x, no hierarchy at all, which
                is why the submenu read as more top-level items rather than as
                children of one.

                Padding the *container* is the right lever: it moves the icon and the
                label together, which padding the button alone would not (the button's
                icon would stay put and only the text shift, so the row would look
                misaligned rather than indented).

                `pl-5` is 1.25rem against the default 0.5rem, a 0.75rem step that
                reads as a level without wasting width. Reset to `p-2` when the
                sidebar collapses to the icon rail, or the icons would drift right of
                centre - the button's own `p-2!` cannot undo a parent's padding.
              */}
              <SidebarMenu className="pl-5 group-data-[collapsible=icon]:p-2">
                {section.items.map((item) => {
                  const [hrefPath] = item.href.split('?');
                  const isActive =
                    (pathname === hrefPath ||
                      (hrefPath === '/operations' && pathname.startsWith('/operations/'))) &&
                    filtersMatch(item.href, search);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        isActive={isActive}
                        tooltip={item.label}
                        render={<Link href={item.href} />}
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </>
  );
}

function AppSidebar({
  sections,
  collapsed,
  onToggleSection,
  loading,
}: {
  sections: NavSection[];
  collapsed: ReadonlySet<string>;
  onToggleSection: (key: string) => void;
  loading: boolean;
}) {
  const { open } = useSidebar();
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex h-8 items-center gap-2 px-2">
          <div
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground"
          >
            OE
          </div>
          {open && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">OpenERP</p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                EC&amp;I Contracting
              </p>
            </div>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === '/dashboard'}
              tooltip="Dashboard"
              render={<Link href="/dashboard" />}
            >
              <Gauge aria-hidden="true" />
              <span>Dashboard</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        <SidebarSeparator />

        {/*
          Active-state highlighting compares against the query string, so this
          subtree reads `useSearchParams` and is given its own boundary. The
          header, brand block and user menu above it paint without waiting.
        */}
        <Suspense fallback={<SidebarMenuSkeletonList />}>
          <NavSectionList
            sections={sections}
            collapsed={collapsed}
            onToggleSection={onToggleSection}
            loading={loading}
          />
        </Suspense>
      </SidebarContent>

      <SidebarFooter>
        {/*
          Hidden in icon mode. The rail is ~48px wide there, so this sentence
          wrapped one word per line down the side of the screen, which is the most
          visible layout bug in collapsed mode.
        */}
        {open && (
          <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
            Session held in an HTTP-only cookie.
          </p>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
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
