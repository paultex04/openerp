'use client';

/**
 * Timesheets: recording hours against jobs, approving the week, and reading what
 * the hours cost.
 *
 * ## Why this is its own section
 *
 * Timesheets were deliberately kept out of Job Management. A job is scoped,
 * executed and invoiced by the commercial pipeline; who worked on it and for how
 * long is a separate record with a separate lifecycle and a different audience —
 * the supervisor who types it and the manager who signs it off. Bolting a week
 * grid onto the job screen would have made the job screen the place hours are
 * entered, which is exactly the coupling this phase exists to avoid.
 *
 * The link between the two is one-directional and computed, never stored: costing
 * reads approved hours and the job's revenue and reports a margin. No screen here
 * writes a `job_service_code`, an actual or an invoice.
 *
 * ## Tabs, not pages
 *
 * Each tab declares the permission that reveals it, so a deep link to
 * `?tab=approvals` for someone who cannot approve lands on "no access" instead of
 * a screen of 403s. The API re-checks every call; this only avoids the round trip.
 */
import { useSearchParams } from 'next/navigation';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { usePermissions } from '@/components/auth/usePermissions';
import { useUrlParam } from '@/hooks/use-url-param';
import { ApprovalsPanel } from '@/components/timesheets/approvals-panel';
import { TimesheetEntryPanel } from '@/components/timesheets/entry-panel';
import { ProfitabilityPanel } from '@/components/timesheets/profitability-panel';

type Tab = 'enter' | 'approvals' | 'profitability';

const TAB_KEYS: readonly Tab[] = ['enter', 'approvals', 'profitability'];

interface TabDef {
  key: Tab;
  label: string;
  /** Reveals the tab. Mirrors the permission the API enforces. */
  anyOf: readonly string[];
}

const TABS: readonly TabDef[] = [
  {
    key: 'enter',
    label: 'Enter time',
    anyOf: ['timesheet.write.own', 'timesheet.read.own', 'timesheet.write'],
  },
  { key: 'approvals', label: 'Approvals', anyOf: ['timesheet.approve'] },
  { key: 'profitability', label: 'Labour profitability', anyOf: ['timesheet.read'] },
];

export default function TimesheetsPage() {
  // URL-backed so the sidebar can deep-link each tab and the approval queue can be
  // linked straight at a reviewer.
  const [tab, setTab] = useUrlParam<Tab>('tab', TAB_KEYS, 'enter');
  const { permissions, loading } = usePermissions();

  const allowed = (def: TabDef) => def.anyOf.some((permission) => permissions.includes(permission));
  const visible = TABS.filter(allowed);

  // `useUrlParam` cannot tell "the URL asked for ?tab=approvals" apart from "the
  // URL said nothing, so the fallback applies". Only the first deserves a refusal:
  // a QS opening /timesheets should quietly land on the tab they can use.
  const searchParams = useSearchParams();
  const asked = searchParams.has('tab');
  const requested = TABS.find((def) => def.key === tab);
  const permitted = requested ? allowed(requested) : true;
  const fallbackTab = visible[0]?.key;
  const activeTab = permitted || asked ? tab : (fallbackTab ?? tab);
  const refuse = asked && !permitted;

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6">
        <p className="py-16 text-center text-sm text-muted-foreground">Loading permissions…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Timesheets</h1>
        <p className="text-sm text-muted-foreground">
          Record hours against jobs, approve the week, and read the labour cost behind every job's
          margin.
        </p>
      </header>

      <nav aria-label="Timesheet views" className="flex flex-wrap items-center gap-1">
        {visible.map((def) => (
          <Button
            key={def.key}
            size="sm"
            variant={activeTab === def.key ? 'default' : 'ghost'}
            aria-current={activeTab === def.key ? 'page' : undefined}
            onClick={() => setTab(def.key)}
          >
            {def.label}
          </Button>
        ))}
      </nav>

      {visible.length === 0 && (
        <Alert>
          Your account holds no timesheet permission. Ask an administrator for the access you need.
        </Alert>
      )}

      {refuse ? (
        <Alert>
          You do not have permission to open “{requested?.label ?? tab}”. It needs{' '}
          <code className="font-mono">{requested?.anyOf.join(' or ')}</code>.
        </Alert>
      ) : (
        <>
          {activeTab === 'enter' && <TimesheetEntryPanel />}
          {activeTab === 'approvals' && <ApprovalsPanel />}
          {activeTab === 'profitability' && <ProfitabilityPanel />}
        </>
      )}
    </div>
  );
}
