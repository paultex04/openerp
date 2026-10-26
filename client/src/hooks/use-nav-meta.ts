'use client';

/**
 * Navigation Metadata & Live Badge Counters.
 *
 * Derives the active domain from the current URL, tracks navigation history,
 * and queries live pending badge counts for timesheets, tasks, and messages.
 */
import { useQuery } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { usePermissions } from '@/components/auth/usePermissions';
import { useChat } from '@/components/chat/chat-provider';
import { api, type TaskSummaryRow, type TimesheetSummary } from '@/lib/api';
import { breadcrumbFor } from '@/lib/nav';
import { useDualRail } from '@/lib/nav-store';

export function useNavMeta() {
  const pathname = usePathname();
  const { can } = usePermissions();
  const { setActiveDomain, addRecent } = useDualRail();

  // Safe chat context reader
  let unreadMessagesCount = 0;
  try {
    const chat = useChat();
    unreadMessagesCount = chat.unreadTotal;
  } catch {
    // ChatProvider might not be mounted in rare views
  }

  // Derive domain from current pathname
  useEffect(() => {
    let domain = 'dashboard';
    if (pathname === '/dashboard' || pathname === '/') {
      domain = 'dashboard';
    } else if (pathname.startsWith('/commercial')) {
      domain = 'commercial';
    } else if (pathname.startsWith('/operations')) {
      domain = 'operations';
    } else if (pathname.startsWith('/timesheets')) {
      domain = 'timesheets';
    } else if (pathname.startsWith('/billing')) {
      domain = 'billing';
    } else if (pathname.startsWith('/tasks') || pathname.startsWith('/messages')) {
      domain = 'tasks';
    } else if (pathname.startsWith('/admin')) {
      domain = 'administration';
    }

    setActiveDomain(domain);

    // Track recent history
    const trail = breadcrumbFor(pathname, '');
    const label = trail?.item.label ?? (pathname === '/dashboard' ? 'Dashboard' : pathname.replace('/', ''));
    if (label && pathname !== '/login') {
      addRecent({ href: pathname, label });
    }
  }, [pathname, setActiveDomain, addRecent]);

  // Timesheet pending approvals count
  const approvalsQuery = useQuery({
    queryKey: ['timesheets-pending-count'],
    queryFn: () => api.get<{ timesheets: TimesheetSummary[] }>('/api/timesheets/approvals'),
    enabled: can('timesheet.approve'),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const timesheetApprovalsCount = approvalsQuery.data?.timesheets?.length ?? 0;

  // Active tasks count assigned to current user
  const tasksQuery = useQuery({
    queryKey: ['my-active-tasks-count'],
    queryFn: () =>
      api.get<{ tasks: TaskSummaryRow[]; total: number }>('/api/tasks', {
        assignedToMe: true,
        includeCompleted: false,
      }),
    enabled: can('task.read'),
    refetchInterval: 60000,
    staleTime: 30000,
  });

  const tasksAssignedCount = tasksQuery.data?.tasks?.length ?? 0;

  return {
    timesheetApprovalsCount,
    tasksAssignedCount,
    unreadMessagesCount,
  };
}
