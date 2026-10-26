'use client';

/**
 * 56px Primary Icon Rail (Linear / Slack style).
 *
 * Slim, persistent vertical rail displaying the application brand, primary domain
 * icons with live counter badges, and bottom controls (pin drawer, user menu).
 */
import {
  Building2,
  Clock,
  FolderKanban,
  Gauge,
  History,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ShieldCheck,
  Star,
  type LucideIcon,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useDualRail } from '@/lib/nav-store';
import { useNavMeta } from '@/hooks/use-nav-meta';
import { usePermissions } from '@/components/auth/usePermissions';
import { cn } from 'cn';

interface RailItem {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  permission?: string;
  badge?: number;
  hasDot?: boolean;
}

export function NavIconRail() {
  const router = useRouter();
  const { can, canAny } = usePermissions();
  const {
    isPinned,
    togglePin,
    activeDomain,
    setActiveDomain,
    flyoutOpen,
    setFlyoutOpen,
    favorites,
    recents,
  } = useDualRail();

  const { timesheetApprovalsCount, tasksAssignedCount, unreadMessagesCount } = useNavMeta();

  // Primary workspace navigation items
  const primaryTools: RailItem[] = [
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: Gauge,
      href: '/dashboard',
    },
    {
      id: 'favorites',
      label: 'Favorites',
      icon: Star,
      badge: favorites.length > 0 ? favorites.length : undefined,
    },
    {
      id: 'recents',
      label: 'Recents',
      icon: History,
      badge: recents.length > 0 ? recents.length : undefined,
    },
  ];

  // Domain module items
  const domains: RailItem[] = [
    {
      id: 'commercial',
      label: 'Commercial & Contracts',
      icon: Building2,
      permission: 'commercial',
    },
    {
      id: 'operations',
      label: 'Operations & Jobs',
      icon: FolderKanban,
      permission: 'operations',
    },
    {
      id: 'timesheets',
      label: 'Timesheets & Approvals',
      icon: Clock,
      permission: 'timesheets',
      badge: timesheetApprovalsCount > 0 ? timesheetApprovalsCount : undefined,
    },
    {
      id: 'billing',
      label: 'Billing & Invoices',
      icon: Receipt,
      permission: 'billing',
    },
    {
      id: 'tasks',
      label: 'Tasks & Collaboration',
      icon: ListTodo,
      permission: 'tasks',
      badge: tasksAssignedCount > 0 ? tasksAssignedCount : undefined,
      hasDot: unreadMessagesCount > 0,
    },
    {
      id: 'administration',
      label: 'Administration',
      icon: ShieldCheck,
      permission: 'admin',
    },
  ];

  const handleDomainClick = (item: RailItem) => {
    setActiveDomain(item.id);

    // If unpinned, toggle or open flyout drawer
    if (!isPinned) {
      if (flyoutOpen && activeDomain === item.id) {
        setFlyoutOpen(false);
      } else {
        setFlyoutOpen(true);
      }
    }

    // Direct dashboard link
    if (item.href) {
      router.push(item.href);
      if (!isPinned) setFlyoutOpen(false);
    }
  };

  const renderRailItem = (item: RailItem) => {
    // Permission check
    if (item.permission === 'commercial' && !canAny('contract.read', 'costparameter.read', 'ratemaster.read', 'servicecode.read')) return null;
    if (item.permission === 'operations' && !canAny('project.read', 'job.read', 'deliverable.read')) return null;
    if (item.permission === 'timesheets' && !canAny('timesheet.write.own', 'timesheet.read.own', 'timesheet.write', 'timesheet.read', 'timesheet.approve')) return null;
    if (item.permission === 'billing' && !can('invoice.read')) return null;
    if (item.permission === 'tasks' && !canAny('task.read', 'chat.read')) return null;
    if (item.permission === 'admin' && !canAny('admin.user.read', 'admin.role.read', 'admin.audit.read', 'employee.read')) return null;

    const isActive = activeDomain === item.id;
    const Icon = item.icon;

    return (
      <Tooltip key={item.id}>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => handleDomainClick(item)}
              className={cn(
                'group relative flex size-10 items-center justify-center rounded-lg transition-all cursor-pointer',
                isActive
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {/* Active vertical left bar */}
              {isActive && (
                <span
                  className="absolute -left-[1px] top-2 bottom-2 w-1 rounded-r-full bg-primary"
                  aria-hidden="true"
                />
              )}

              <Icon className={cn('size-5 transition-transform group-hover:scale-110', isActive && 'stroke-[2.25]')} />

              {/* Numeric Counter Badge (e.g. pending approvals, tasks, favorites, or recents) */}
              {item.badge !== undefined && item.badge > 0 && (
                <span
                  className={cn(
                    'absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white shadow-xs',
                    item.id === 'favorites'
                      ? 'bg-amber-500'
                      : item.id === 'recents'
                      ? 'bg-slate-500'
                      : 'bg-rose-500',
                  )}
                >
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}

              {/* Dot Indicator (e.g. unread messages) */}
              {item.hasDot && (
                <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-emerald-500 ring-2 ring-card" />
              )}
            </button>
          }
        />
        <TooltipContent side="right" sideOffset={12}>
          <p className="font-medium">{item.label}</p>
          {item.badge && (
            <p
              className={cn(
                'text-[10px]',
                item.id === 'favorites'
                  ? 'text-amber-400'
                  : item.id === 'recents'
                  ? 'text-slate-300'
                  : 'text-rose-400',
              )}
            >
              {item.id === 'favorites'
                ? `${item.badge} saved`
                : item.id === 'recents'
                ? `${item.badge} recent`
                : `${item.badge} pending`}
            </p>
          )}
          {item.hasDot && <p className="text-[10px] text-emerald-400">Unread messages</p>}
        </TooltipContent>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delay={200}>
      <aside
        className="relative flex h-full w-14 shrink-0 flex-col items-center justify-between border-r bg-card py-3 select-none z-50"
        aria-label="Primary Navigation"
      >
        {/* Top: Brand Monogram */}
        <div className="flex flex-col items-center gap-4">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="flex size-9 items-center justify-center rounded-lg bg-primary text-xs font-bold text-primary-foreground shadow-xs transition-transform hover:scale-105 active:scale-95 cursor-pointer"
                  aria-label="OpenERP Home"
                >
                  OE
                </button>
              }
            />
            <TooltipContent side="right" sideOffset={12}>
              <p className="font-semibold">OpenERP</p>
              <p className="text-[10px] text-muted-foreground">EC&amp;I Contracting</p>
            </TooltipContent>
          </Tooltip>

          {/* Divider */}
          <div className="h-px w-7 bg-border/60" />

          {/* Middle: Navigation Rails */}
          <nav className="flex flex-col items-center gap-1.5">
            {/* Primary Workspace Tools: Dashboard & Favorites */}
            {primaryTools.map(renderRailItem)}

            {/* Section Divider */}
            <div className="h-px w-6 bg-border/60 my-0.5" aria-hidden="true" />

            {/* ERP Domain Modules */}
            {domains.map(renderRailItem)}
          </nav>
        </div>

        {/* Bottom Rail Controls */}
        <div className="flex flex-col items-center gap-2">
          {/* Pin/Collapse Drawer Toggle */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={togglePin}
                  className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                  aria-label={isPinned ? 'Unpin context drawer' : 'Pin context drawer'}
                >
                  {isPinned ? (
                    <PanelLeftClose className="size-4.5" />
                  ) : (
                    <PanelLeftOpen className="size-4.5" />
                  )}
                </button>
              }
            />
            <TooltipContent side="right" sideOffset={12}>
              <p className="font-medium">
                {isPinned ? 'Unpin Drawer (Maximize Table Width)' : 'Pin Drawer Open'}
              </p>
              <p className="text-[10px] text-muted-foreground">Shortcut: Ctrl + [</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
