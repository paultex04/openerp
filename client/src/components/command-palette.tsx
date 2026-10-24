'use client';

/**
 * Universal Command Palette (`Ctrl+K` / `Cmd+K`) (Phase 6).
 *
 * Provides global fuzzy navigation and quick entity lookup across:
 *  - Primary system views (Dashboard, Operations, Commercial, Billing, Timesheets, Admin)
 *  - Live Jobs, Commercial Contracts, and Invoices
 *  - Quick system shortcuts (toggle dark mode, open messages)
 */
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Briefcase,
  Clock,
  Compass,
  FileSpreadsheet,
  FileText,
  Gauge,
  HardHat,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sun,
  User,
  Users,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { api, type ContractRow, type InvoiceRow, type JobRow } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  applyTheme,
  DARK_THEME,
  DEFAULT_THEME,
  readAppliedTheme,
  subscribeToTheme,
  THEME_STORAGE_KEY,
  type ThemeId,
} from '@/lib/theme';
import { useSyncExternalStore } from 'react';

interface PaletteItem {
  id: string;
  category: 'Navigation' | 'Jobs' | 'Contracts' | 'Invoices' | 'Quick Actions';
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  action: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [liveJobs, setLiveJobs] = useState<JobRow[]>([]);
  const [liveContracts, setLiveContracts] = useState<ContractRow[]>([]);
  const [liveInvoices, setLiveInvoices] = useState<InvoiceRow[]>([]);
  const router = useRouter();

  const currentTheme = useSyncExternalStore(
    subscribeToTheme,
    readAppliedTheme,
    () => DEFAULT_THEME,
  );
  const isDark = currentTheme === DARK_THEME;

  // Toggle open on Ctrl+K / Cmd+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Debounced search on typed query
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setLiveJobs([]);
      setLiveContracts([]);
      setLiveInvoices([]);
      return;
    }

    const timer = setTimeout(async () => {
      const q = encodeURIComponent(query.trim());
      try {
        const [jobsRes, contractsRes, invoicesRes] = await Promise.allSettled([
          api.get<{ jobs: JobRow[] }>(`/api/jobs?search=${q}`),
          api.get<{ contracts: ContractRow[] }>(`/api/contracts?search=${q}`),
          api.get<{ invoices: InvoiceRow[] }>(`/api/invoices?search=${q}`),
        ]);

        if (jobsRes.status === 'fulfilled') setLiveJobs(jobsRes.value.jobs?.slice(0, 4) ?? []);
        if (contractsRes.status === 'fulfilled')
          setLiveContracts(contractsRes.value.contracts?.slice(0, 4) ?? []);
        if (invoicesRes.status === 'fulfilled')
          setLiveInvoices(invoicesRes.value.invoices?.slice(0, 4) ?? []);
      } catch {
        // Ignore search errors in command palette
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [open, query]);

  const navigateTo = useCallback(
    (url: string) => {
      setOpen(false);
      setQuery('');
      router.push(url);
    },
    [router],
  );

  const toggleTheme = useCallback(() => {
    const next: ThemeId = isDark ? DEFAULT_THEME : DARK_THEME;
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore
    }
    setOpen(false);
  }, [isDark]);

  // Build items list
  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];

    // Static Navigation
    const navItems: PaletteItem[] = [
      {
        id: 'nav-dashboard',
        category: 'Navigation',
        title: 'Command Centre Dashboard',
        subtitle: 'Executive KPIs, revenue trends and pipeline',
        icon: Gauge,
        action: () => navigateTo('/dashboard'),
      },
      {
        id: 'nav-operations',
        category: 'Navigation',
        title: 'Operations & Jobs',
        subtitle: 'Field work orders, scoping, deliverables and crew assignments',
        icon: HardHat,
        action: () => navigateTo('/operations'),
      },
      {
        id: 'nav-crew-matrix',
        category: 'Navigation',
        title: 'Weekly Crew Matrix',
        subtitle: 'Bulk supervisor grid for recording team weekly hours',
        icon: Users,
        action: () => navigateTo('/timesheets/crew-matrix'),
      },
      {
        id: 'nav-timesheets',
        category: 'Navigation',
        title: 'Timesheets & Costing',
        subtitle: 'Weekly timesheets, approvals and labour profitability',
        icon: Clock,
        action: () => navigateTo('/timesheets'),
      },
      {
        id: 'nav-contracts',
        category: 'Navigation',
        title: 'Commercial Contracts & Amendments',
        subtitle: 'Client master agreements and index revisions',
        icon: FileText,
        action: () => navigateTo('/commercial?tab=contracts'),
      },
      {
        id: 'nav-rates',
        category: 'Navigation',
        title: 'Rate Cards & Buildup',
        subtitle: 'Tier 1 labour master rates and cost components',
        icon: Briefcase,
        action: () => navigateTo('/commercial?tab=rates'),
      },
      {
        id: 'nav-recipes',
        category: 'Navigation',
        title: 'Service Code Recipes (Tier 2)',
        subtitle: 'Activity labour crew compositions and R1 material BOMs',
        icon: Compass,
        action: () => navigateTo('/commercial?tab=service-codes'),
      },
      {
        id: 'nav-billing',
        category: 'Navigation',
        title: 'Invoices & Billing',
        subtitle: 'Tax invoices, generation, approvals and payment tracking',
        icon: FileSpreadsheet,
        action: () => navigateTo('/billing'),
      },
      {
        id: 'nav-chat',
        category: 'Navigation',
        title: 'Internal Chat & Messages',
        subtitle: 'Real-time team messaging and operational attachments',
        icon: MessageSquare,
        action: () => navigateTo('/messages'),
      },
      {
        id: 'nav-profile',
        category: 'Navigation',
        title: 'User Profile & Avatar',
        subtitle: 'Personal details and security credentials',
        icon: User,
        action: () => navigateTo('/profile'),
      },
      {
        id: 'nav-admin',
        category: 'Navigation',
        title: 'System Administration',
        subtitle: 'User management, RBAC matrix, workflow and audit trail',
        icon: Settings,
        action: () => navigateTo('/admin'),
      },
    ];

    // Quick Actions
    const quickActions: PaletteItem[] = [
      {
        id: 'act-theme',
        category: 'Quick Actions',
        title: isDark ? 'Switch to Light Surface' : 'Switch to Dark Surface (Midnight)',
        subtitle: 'Change interface color theme immediately',
        icon: isDark ? Sun : Moon,
        action: toggleTheme,
      },
    ];

    // Filter Navigation by query if present
    const qLower = query.toLowerCase().trim();
    if (qLower.length > 0) {
      const filteredNav = navItems.filter(
        (item) =>
          item.title.toLowerCase().includes(qLower) ||
          item.subtitle?.toLowerCase().includes(qLower),
      );
      list.push(...filteredNav);
    } else {
      list.push(...navItems);
      list.push(...quickActions);
    }

    // Add Live Jobs
    if (liveJobs.length > 0) {
      for (const job of liveJobs) {
        list.push({
          id: `job-${job.id}`,
          category: 'Jobs',
          title: `Job #${job.id}: ${job.description || 'EC&I Work'}`,
          subtitle: `${job.project?.contract?.client?.name ?? ''} · WO: ${job.workOrder || 'N/A'}`,
          icon: HardHat,
          badge: job.status,
          action: () => navigateTo(`/operations?job=${job.id}`),
        });
      }
    }

    // Add Live Contracts
    if (liveContracts.length > 0) {
      for (const c of liveContracts) {
        list.push({
          id: `contract-${c.id}`,
          category: 'Contracts',
          title: `${c.number}: ${c.description}`,
          subtitle: c.client?.name ?? '',
          icon: FileText,
          badge: `${c.amendments?.length ?? 0} amendments`,
          action: () => navigateTo(`/commercial?tab=contracts&search=${c.number}`),
        });
      }
    }

    // Add Live Invoices
    if (liveInvoices.length > 0) {
      for (const inv of liveInvoices) {
        list.push({
          id: `invoice-${inv.id}`,
          category: 'Invoices',
          title: `Invoice ${inv.invoiceNumber}`,
          subtitle: `${inv.job?.project?.contract?.client?.name ?? ''}`,
          icon: FileSpreadsheet,
          badge: inv.status,
          action: () => navigateTo(`/billing?search=${inv.invoiceNumber}`),
        });
      }
    }

    return list;
  }, [query, liveJobs, liveContracts, liveInvoices, isDark, navigateTo, toggleTheme]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const current = items[selectedIndex];
      if (current) current.action();
    }
  };

  useEffect(() => {
    setSelectedIndex(0);
  }, [items.length, query]);

  return (
    <>
      {/* Header Search Trigger Button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden md:flex items-center gap-2 rounded-md border border-input bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors w-48 lg:w-64"
      >
        <Search className="size-3.5 shrink-0" />
        <span className="flex-1 text-left truncate">Search or jump to…</span>
        <kbd className="pointer-events-none hidden sm:inline-flex h-4 select-none items-center gap-0.5 rounded border bg-background px-1 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
        </kbd>
      </button>

      {/* Palette Modal */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="p-0 max-w-xl overflow-hidden rounded-xl shadow-2xl border">
          <DialogTitle className="sr-only">Quick Command Palette</DialogTitle>

          {/* Search Input Bar */}
          <div className="flex items-center border-b px-3.5 py-2.5 gap-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command or search jobs, contracts, invoices…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
            {query.length > 0 && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-[11px] text-muted-foreground hover:text-foreground px-1"
              >
                Clear
              </button>
            )}
          </div>

          {/* Results List */}
          <div className="max-h-80 overflow-y-auto p-2 space-y-1">
            {items.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                No matching results found for &ldquo;{query}&rdquo;.
              </div>
            ) : (
              items.map((item, index) => {
                const isSelected = index === selectedIndex;
                const Icon = item.icon;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={item.action}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={cn(
                      'w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-xs transition-colors',
                      isSelected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/60',
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          isSelected ? 'text-primary-foreground' : 'text-muted-foreground',
                        )}
                      />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{item.title}</p>
                        {item.subtitle && (
                          <p
                            className={cn(
                              'text-[11px] truncate',
                              isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground',
                            )}
                          >
                            {item.subtitle}
                          </p>
                        )}
                      </div>
                    </div>
                    {item.badge && (
                      <Badge
                        variant={isSelected ? 'secondary' : 'outline'}
                        className="text-[10px] shrink-0"
                      >
                        {item.badge}
                      </Badge>
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* Footer Guide */}
          <div className="flex items-center justify-between border-t bg-muted/30 px-3.5 py-1.5 text-[10px] text-muted-foreground">
            <span>Navigation & Quick Jump</span>
            <div className="flex items-center gap-3">
              <span>↑↓ Navigate</span>
              <span>↵ Open</span>
              <span>ESC Close</span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
