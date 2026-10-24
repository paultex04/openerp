'use client';

/**
 * Real-Time Notification Center (Phase 6).
 *
 * Surfaces actionable operational alerts and sign-off requests:
 *  - Submitted Invoices awaiting billing approval
 *  - Submitted Timesheets awaiting manager/commercial approval
 *  - Lapsed and near-expiry contract amendments (< 30 days)
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  FileSpreadsheet,
  FileWarning,
} from 'lucide-react';
import Link from 'next/link';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { usePermissions } from '@/components/auth/usePermissions';
import { api, type DashboardAnalyticsResponse, type InvoiceRow } from '@/lib/api';
import { formatDate, formatZar } from '@/lib/format';

interface NotificationItem {
  id: string;
  type: 'invoice' | 'timesheet' | 'amendment';
  title: string;
  description: string;
  timestamp?: string;
  badge: string;
  badgeVariant?: 'default' | 'destructive' | 'warning' | 'secondary';
  href: string;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { can } = usePermissions();

  const mayReadInvoices = can('invoice.read');
  const mayApproveTimesheets = can('timesheet.approve');

  // 1. Invoices awaiting approval (Submitted)
  const submittedInvoicesQuery = useQuery({
    queryKey: ['invoices-submitted'],
    queryFn: () => api.get<{ invoices: InvoiceRow[] }>('/api/invoices?status=Submitted'),
    enabled: mayReadInvoices,
    staleTime: 30_000,
  });

  // 2. Timesheet approvals
  const timesheetApprovalsQuery = useQuery({
    queryKey: ['timesheets-approvals'],
    queryFn: () => api.get<{ timesheets: any[] }>('/api/timesheets/approvals'),
    enabled: mayApproveTimesheets,
    staleTime: 30_000,
  });

  // 3. Analytics (for urgent amendment expiries)
  const analyticsQuery = useQuery({
    queryKey: ['dashboard-analytics'],
    queryFn: () => api.get<DashboardAnalyticsResponse>('/api/analytics/dashboard'),
    staleTime: 30_000,
  });

  // Aggregate notification items
  const items = useMemo<NotificationItem[]>(() => {
    const list: NotificationItem[] = [];

    // Submitted invoices
    const invoices = submittedInvoicesQuery.data?.invoices ?? [];
    for (const inv of invoices) {
      list.push({
        id: `inv-${inv.id}`,
        type: 'invoice',
        title: `Invoice ${inv.invoiceNumber} awaiting approval`,
        description: `${inv.job.project.contract.client.name} · ${formatZar(inv.totalWithTax)}`,
        timestamp: inv.issueDate ? formatDate(inv.issueDate) : undefined,
        badge: 'Invoice',
        badgeVariant: 'warning',
        href: '/billing',
      });
    }

    // Submitted timesheets
    const timesheets = timesheetApprovalsQuery.data?.timesheets ?? [];
    for (const ts of timesheets) {
      list.push({
        id: `ts-${ts.id}`,
        type: 'timesheet',
        title: `Timesheet: ${ts.employee?.name ?? ''} ${ts.employee?.surname ?? ''}`,
        description: `Week starting ${ts.periodStart ? formatDate(ts.periodStart) : ''} · ${ts.totalHours ?? 0} hours`,
        badge: 'Timesheet',
        badgeVariant: 'default',
        href: '/timesheets?tab=approvals',
      });
    }

    // Urgent expiring amendments
    const amendments = analyticsQuery.data?.operations?.expiringAmendments ?? [];
    for (const am of amendments) {
      if (am.band === 'expired' || am.band === 'within 30 days') {
        list.push({
          id: `am-${am.id}`,
          type: 'amendment',
          title: `Amendment ${am.amendmentNumber} (${am.contractNumber})`,
          description: `${am.clientName} · ${am.band === 'expired' ? `Lapsed ${Math.abs(am.daysRemaining)}d ago` : `Expires in ${am.daysRemaining} days`}`,
          badge: am.band === 'expired' ? 'Lapsed' : 'Urgent Expiry',
          badgeVariant: am.band === 'expired' ? 'destructive' : 'warning',
          href: '/commercial?tab=contracts',
        });
      }
    }

    return list;
  }, [
    submittedInvoicesQuery.data,
    timesheetApprovalsQuery.data,
    analyticsQuery.data?.operations?.expiringAmendments,
  ]);

  const unreadCount = items.length;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative size-9"
                  aria-label={`Notifications (${unreadCount} items)`}
                >
                  <Bell className="size-4" />
                  {unreadCount > 0 && (
                    <span className="absolute top-1.5 right-1.5 flex size-2 items-center justify-center">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                    </span>
                  )}
                </Button>
              }
            />
          }
        />
        <TooltipContent>
          {unreadCount === 0 ? 'No alerts' : `${unreadCount} alerts requiring attention`}
        </TooltipContent>
      </Tooltip>

      <SheetContent className="flex flex-col p-0 sm:max-w-md w-full">
        <SheetHeader className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SheetTitle className="text-base font-semibold">Notification Center</SheetTitle>
              {unreadCount > 0 && (
                <Badge variant="secondary" className="font-mono text-xs">
                  {unreadCount}
                </Badge>
              )}
            </div>
          </div>
          <SheetDescription className="text-xs">
            Pending approvals, sign-offs and contract compliance horizons.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          {items.length === 0 ? (
            <div className="py-12 flex flex-col items-center justify-center text-center space-y-2">
              <CheckCircle2 className="size-8 text-emerald-500/80" />
              <p className="text-sm font-medium">All caught up</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                There are no invoices awaiting approval, submitted timesheets, or urgent amendment
                expiries today.
              </p>
            </div>
          ) : (
            items.map((item) => {
              const Icon =
                item.type === 'invoice'
                  ? FileSpreadsheet
                  : item.type === 'timesheet'
                    ? ClipboardCheck
                    : item.badgeVariant === 'destructive'
                      ? AlertTriangle
                      : FileWarning;

              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="size-6 rounded-full bg-muted flex items-center justify-center shrink-0">
                        <Icon className="size-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                      </div>
                      <span className="font-medium text-xs leading-tight">{item.title}</span>
                    </div>
                    <Badge
                      variant={item.badgeVariant ?? 'outline'}
                      className="text-[10px] shrink-0"
                    >
                      {item.badge}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground ml-8">{item.description}</p>
                </Link>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
