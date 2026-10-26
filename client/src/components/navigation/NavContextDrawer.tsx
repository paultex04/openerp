'use client';

/**
 * 220px Context Drawer (Linear / Slack style).
 *
 * Secondary navigation pane showing active domain sub-links, quick route search,
 * starred favorites, and recent history. Supports pinned dock and unpinned flyout.
 */
import {
  Building2,
  Clock,
  FileSpreadsheet,
  FolderKanban,
  History,
  Inbox,
  ListTodo,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Star,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState, useMemo } from 'react';
import { usePermissions } from '@/components/auth/usePermissions';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { NAV_SECTIONS } from '@/lib/nav';
import { useDualRail } from '@/lib/nav-store';
import { cn } from 'cn';

interface ContextDomainConfig {
  title: string;
  icon: LucideIcon;
  sectionKey?: string;
  customItems?: Array<{ href: string; label: string; icon: LucideIcon }>;
}

const DOMAIN_CONFIGS: Record<string, ContextDomainConfig> = {
  dashboard: {
    title: 'Dashboard & Reports',
    icon: Building2,
    customItems: [
      { href: '/dashboard', label: 'Executive Dashboard', icon: FileSpreadsheet },
    ],
  },
  favorites: {
    title: 'Favorites',
    icon: Star,
  },
  commercial: {
    title: 'Commercial & Contracts',
    icon: Building2,
    sectionKey: 'commercial',
  },
  operations: {
    title: 'Operations & Jobs',
    icon: FolderKanban,
    sectionKey: 'operations',
  },
  timesheets: {
    title: 'Timesheets & Matrix',
    icon: Clock,
    sectionKey: 'timesheets',
  },
  billing: {
    title: 'Billing & Finance',
    icon: FileSpreadsheet,
    sectionKey: 'billing',
  },
  tasks: {
    title: 'Tasks & Workflow',
    icon: ListTodo,
    customItems: [
      { href: '/tasks', label: 'Inbox (All Tasks)', icon: Inbox },
      { href: '/tasks', label: 'Task Board', icon: ListTodo },
    ],
  },
  messages: {
    title: 'Collaboration',
    icon: MessageSquare,
    customItems: [
      { href: '/messages', label: 'Direct Messages', icon: MessageSquare },
      { href: '/tasks', label: 'Tasks', icon: ListTodo },
    ],
  },
  administration: {
    title: 'System Administration',
    icon: Users,
    sectionKey: 'administration',
  },
};

export function NavContextDrawer() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? '';
  const { canAny } = usePermissions();

  const {
    isPinned,
    togglePin,
    activeDomain,
    flyoutOpen,
    setFlyoutOpen,
    favorites,
    toggleFavorite,
    isFavorite,
    recents,
    clearRecents,
  } = useDualRail();

  const [routeFilter, setRouteFilter] = useState('');

  const config = DOMAIN_CONFIGS[activeDomain] ?? DOMAIN_CONFIGS.operations!;

  // Collect items for the active domain
  const rawItems = useMemo(() => {
    if (activeDomain === 'favorites') {
      const allNavItems = NAV_SECTIONS.flatMap((s) => s.items);
      return favorites.map((fav) => {
        const found = allNavItems.find((item) => item.href === fav.href);
        return {
          href: fav.href,
          label: fav.label,
          icon: found ? found.icon : Star,
        };
      });
    }

    if (config.customItems) return config.customItems;
    if (!config.sectionKey) return [];

    const section = NAV_SECTIONS.find((s) => s.key === config.sectionKey);
    if (!section) return [];

    // Filter by permissions
    return section.items.filter((item) => {
      if (item.anyOf.length === 0) return true;
      return canAny(...item.anyOf);
    });
  }, [config, canAny, activeDomain, favorites]);

  // Apply search filter
  const filteredItems = useMemo(() => {
    if (!routeFilter.trim()) return rawItems;
    const q = routeFilter.toLowerCase().trim();
    return rawItems.filter((i) => i.label.toLowerCase().includes(q) || i.href.toLowerCase().includes(q));
  }, [rawItems, routeFilter]);

  const handleLinkClick = () => {
    // If unpinned, close the flyout on navigation
    if (!isPinned) {
      setFlyoutOpen(false);
    }
  };

  // If in unpinned mode and flyout is closed, don't render
  if (!isPinned && !flyoutOpen) {
    return null;
  }

  return (
    <TooltipProvider delay={250}>
      <div
        className={cn(
          'flex h-full w-[220px] shrink-0 flex-col border-r bg-card/95 backdrop-blur-md select-none transition-all duration-200 z-20',
          !isPinned &&
            'fixed left-14 top-0 z-40 shadow-2xl border-r border-border animate-in slide-in-from-left-2 duration-150',
        )}
      >
        {/* Drawer Header */}
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {config.title}
            </h2>
          </div>

          <div className="flex items-center gap-1">
            {/* Pin Toggle Button */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    onClick={togglePin}
                    className="flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
                    aria-label={isPinned ? 'Unpin context drawer' : 'Pin context drawer'}
                  >
                    {isPinned ? <Pin className="size-3.5 fill-current" /> : <PinOff className="size-3.5" />}
                  </button>
                }
              />
              <TooltipContent side="bottom">
                <p className="text-xs">
                  {isPinned ? 'Unpin (Float on hover)' : 'Pin (Keep open)'}
                </p>
              </TooltipContent>
            </Tooltip>

            {/* Close Flyout Button (Unpinned only) */}
            {!isPinned && (
              <button
                type="button"
                onClick={() => setFlyoutOpen(false)}
                className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                aria-label="Close menu"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Route Filter Input */}
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2 size-3 text-muted-foreground" />
            <Input
              type="text"
              placeholder={activeDomain === 'favorites' ? 'Filter favorites...' : 'Filter routes...'}
              value={routeFilter}
              onChange={(e) => setRouteFilter(e.target.value)}
              className="h-7 w-full pl-7 pr-6 text-xs bg-muted/40 border-transparent focus:border-border"
            />
            {routeFilter && (
              <button
                type="button"
                onClick={() => setRouteFilter('')}
                className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Navigation Area */}
        <div className="flex-1 overflow-y-auto p-2 space-y-4">
          {/* Navigation Links or Starred Favorites */}
          <div className="space-y-1">
            <span className="px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
              {activeDomain === 'favorites'
                ? (routeFilter ? 'Matching Favorites' : 'Starred Shortcuts')
                : (routeFilter ? 'Matching Routes' : 'Navigation')}
            </span>
            <div className="space-y-0.5">
              {filteredItems.map((item) => {
                const [itemPath, itemQuery] = item.href.split('?');
                const isPathActive = pathname === itemPath || (itemPath === '/operations' && pathname.startsWith('/operations/'));

                // Exact query parameter match if item specifies one
                let isActive = isPathActive;
                if (itemQuery && search) {
                  const q = new URLSearchParams(search);
                  for (const [k, v] of new URLSearchParams(itemQuery)) {
                    if (q.get(k) !== v) isActive = false;
                  }
                }

                const favorited = isFavorite(item.href);
                const ItemIcon = item.icon;

                return (
                  <div
                    key={item.href}
                    className={cn(
                      'group flex items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                      isActive
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <Link
                      href={item.href}
                      onClick={handleLinkClick}
                      className="flex min-w-0 flex-1 items-center gap-2 truncate"
                    >
                      <ItemIcon className={cn('size-3.5 shrink-0', isActive ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground')} />
                      <span className="truncate">{item.label}</span>
                    </Link>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite({ href: item.href, label: item.label });
                      }}
                      className={cn(
                        'transition-opacity p-0.5 rounded cursor-pointer',
                        favorited
                          ? 'text-amber-500 opacity-100'
                          : 'opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-amber-500',
                      )}
                      title={favorited ? 'Remove from favorites' : 'Pin to favorites'}
                    >
                      <Star className={cn('size-3', favorited && 'fill-current')} />
                    </button>
                  </div>
                );
              })}

              {filteredItems.length === 0 && (
                activeDomain === 'favorites' ? (
                  routeFilter ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground italic">
                      No matching favorites found.
                    </p>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 px-3 text-center">
                      <div className="flex size-9 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 mb-2.5">
                        <Star className="size-4.5" />
                      </div>
                      <p className="text-xs font-semibold text-foreground">No favorites yet</p>
                      <p className="text-[11px] text-muted-foreground mt-1 max-w-[170px] leading-relaxed">
                        Hover over any page in other sections and click the star icon to pin it here.
                      </p>
                    </div>
                  )
                ) : (
                  <p className="px-2 py-3 text-xs text-muted-foreground italic">
                    No matching routes found.
                  </p>
                )
              )}
            </div>
          </div>

          {/* Recent History (shown if no filter active and not in favorites domain) */}
          {!routeFilter && activeDomain !== 'favorites' && recents.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <div className="flex items-center justify-between px-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80 flex items-center gap-1.5">
                  <History className="size-3" />
                  Recent
                </span>
                <button
                  type="button"
                  onClick={clearRecents}
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  Clear
                </button>
              </div>

              <div className="space-y-0.5">
                {recents.map((recent) => (
                  <Link
                    key={recent.href}
                    href={recent.href}
                    onClick={handleLinkClick}
                    className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground truncate transition-colors"
                  >
                    <span className="truncate flex-1">{recent.label}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
