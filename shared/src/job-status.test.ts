import { describe, expect, it } from 'vitest';
import {
  actualsLockReason,
  authoriseTransition,
  canEditActuals,
  canEditPlanned,
  checkTransition,
  DEFAULT_JOB_WORKFLOW,
  isBackward,
  isTerminal,
  isTransitionPermission,
  jobStatusLabel,
  nextStatuses,
  plannedLockReason,
  type JobStatus,
  type JobWorkflow,
} from './job-status';

/** Convenience: build a permission set from role capability lists. */
const perms = (...keys: string[]) => new Set<string>(keys);

const ALL = perms(
  'job.transition.scope',
  'job.transition.execute',
  'job.transition.pack',
  'job.transition.billing',
  'job.transition.invoice',
  'job.transition.cancel',
);

/** The workflow under test. Named so every call site reads the same. */
const wf = DEFAULT_JOB_WORKFLOW;
const statusKeys = wf.statuses.map((status) => status.key);

describe('default catalogue', () => {
  it('defines all 13 statuses, in pipeline order', () => {
    expect(statusKeys).toEqual([
      '00. Cancelled',
      '01. Scoping',
      '01A. Scoped',
      '02. Awaiting PO',
      '03. WNYS',
      '04. WIP',
      '05. Work Complete',
      '06. Actuals in Progress',
      '07. Pack Ready',
      '08. Out for signature',
      '09. Awaiting change order',
      '10. Invoiced',
      '11. Partially Invoiced',
    ]);
  });

  it('gives every status a unique sort order and a label', () => {
    const orders = wf.statuses.map((status) => status.sortOrder);
    expect(new Set(orders).size).toBe(orders.length);
    for (const status of wf.statuses) {
      expect(status.label.length).toBeGreaterThan(3);
    }
  });

  it('treats Cancelled as the only terminal status', () => {
    expect(isTerminal(wf, '00. Cancelled')).toBe(true);
    for (const status of statusKeys.filter((s) => s !== '00. Cancelled')) {
      expect(isTerminal(wf, status)).toBe(false);
    }
  });

  it('offers cancellation from every non-terminal status', () => {
    for (const status of statusKeys.filter((s) => s !== '00. Cancelled')) {
      expect(nextStatuses(wf, status)).toContain('00. Cancelled');
    }
    expect(nextStatuses(wf, '00. Cancelled')).toEqual([]);
  });

  it('keeps cancellation last in the offer, as the pipeline always showed it', () => {
    expect(nextStatuses(wf, '07. Pack Ready')).toEqual([
      '08. Out for signature',
      '10. Invoiced',
      '11. Partially Invoiced',
      '00. Cancelled',
    ]);
  });

  it('references only statuses that exist, with a real capability and a reason', () => {
    for (const t of wf.transitions) {
      expect(statusKeys).toContain(t.from);
      expect(statusKeys).toContain(t.to);
      expect(isTransitionPermission(t.permission)).toBe(true);
      expect(t.reason.length).toBeGreaterThan(5);
    }
  });

  it('has no self edges and no duplicate pairs', () => {
    const pairs = new Set<string>();
    for (const t of wf.transitions) {
      expect(t.from).not.toBe(t.to);
      const pair = `${t.from} ${t.to}`;
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
    }
  });

  it('never lets a terminal status move anywhere', () => {
    for (const t of wf.transitions) {
      expect(isTerminal(wf, t.from), `${t.from} -> ${t.to}`).toBe(false);
    }
  });
});

describe('forward pipeline', () => {
  const forward: Array<[JobStatus, JobStatus]> = [
    ['01. Scoping', '01A. Scoped'],
    ['01A. Scoped', '02. Awaiting PO'],
    ['02. Awaiting PO', '03. WNYS'],
    ['03. WNYS', '04. WIP'],
    ['04. WIP', '05. Work Complete'],
    ['05. Work Complete', '06. Actuals in Progress'],
    ['06. Actuals in Progress', '07. Pack Ready'],
    ['07. Pack Ready', '08. Out for signature'],
    ['08. Out for signature', '09. Awaiting change order'],
    ['09. Awaiting change order', '04. WIP'],
    ['07. Pack Ready', '10. Invoiced'],
    ['07. Pack Ready', '11. Partially Invoiced'],
    ['10. Invoiced', '11. Partially Invoiced'],
  ];

  for (const [from, to] of forward) {
    it(`allows ${from} -> ${to}`, () => {
      expect(checkTransition(wf, from, to).allowed).toBe(true);
    });
  }
});

describe('Phase 3 acceptance: a field supervisor cannot rewind or jump ahead', () => {
  // The supervisor holds execute + pack, nothing else.
  const supervisor = perms('job.transition.execute', 'job.transition.pack');

  it('cannot move a job backwards through the pipeline', () => {
    const backwards: Array<[JobStatus, JobStatus]> = [
      ['06. Actuals in Progress', '05. Work Complete'],
      ['06. Actuals in Progress', '04. WIP'],
      ['07. Pack Ready', '06. Actuals in Progress'],
      ['04. WIP', '03. WNYS'],
      ['03. WNYS', '02. Awaiting PO'],
      ['08. Out for signature', '07. Pack Ready'],
    ];

    for (const [from, to] of backwards) {
      const check = checkTransition(wf, from, to);
      expect(check.allowed, `${from} -> ${to} must be illegal for anyone`).toBe(false);
      expect(check.rejection).toBe('ILLEGAL');
    }
  });

  it('cannot jump directly from 01. Scoping to 10. Invoiced', () => {
    const check = authoriseTransition(wf, '01. Scoping', '10. Invoiced', supervisor);
    expect(check.allowed).toBe(false);
    expect(check.rejection).toBe('ILLEGAL');
    expect(check.reason).toContain('01. Scoping');
    expect(check.reason).toContain('10. Invoiced');
  });

  it('cannot skip the whole pipeline to any later status', () => {
    const later: JobStatus[] = [
      '02. Awaiting PO',
      '03. WNYS',
      '04. WIP',
      '05. Work Complete',
      '06. Actuals in Progress',
      '07. Pack Ready',
      '08. Out for signature',
      '09. Awaiting change order',
      '10. Invoiced',
      '11. Partially Invoiced',
    ];

    for (const to of later) {
      expect(checkTransition(wf, '01. Scoping', to).allowed, `01 -> ${to}`).toBe(false);
    }
  });

  it('cannot touch the scoping stages at all', () => {
    expect(authoriseTransition(wf, '01. Scoping', '01A. Scoped', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
    expect(authoriseTransition(wf, '01A. Scoped', '02. Awaiting PO', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('cannot invoice, regardless of how it reaches pack ready', () => {
    expect(authoriseTransition(wf, '07. Pack Ready', '10. Invoiced', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('cannot cancel a job', () => {
    expect(authoriseTransition(wf, '04. WIP', '00. Cancelled', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('CAN drive its own stages', () => {
    for (const [from, to] of [
      ['02. Awaiting PO', '03. WNYS'],
      ['03. WNYS', '04. WIP'],
      ['04. WIP', '05. Work Complete'],
      ['05. Work Complete', '06. Actuals in Progress'],
      ['06. Actuals in Progress', '07. Pack Ready'],
    ] as Array<[JobStatus, JobStatus]>) {
      expect(authoriseTransition(wf, from, to, supervisor).allowed, `${from} -> ${to}`).toBe(true);
    }
  });

  it('CAN execute a change order back into WIP', () => {
    expect(
      authoriseTransition(wf, '09. Awaiting change order', '04. WIP', supervisor).allowed,
    ).toBe(true);
  });
});

describe('role boundaries', () => {
  const pm = perms('job.transition.scope');
  const billing = perms('job.transition.billing', 'job.transition.invoice');

  it('gives the PM the scoping stages only', () => {
    expect(authoriseTransition(wf, '01. Scoping', '01A. Scoped', pm).allowed).toBe(true);
    expect(authoriseTransition(wf, '01A. Scoped', '02. Awaiting PO', pm).allowed).toBe(true);
    // Execution belongs to the supervisor from here on.
    expect(authoriseTransition(wf, '02. Awaiting PO', '03. WNYS', pm).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('lets the PM reopen scoping', () => {
    expect(authoriseTransition(wf, '01A. Scoped', '01. Scoping', pm).allowed).toBe(true);
  });

  it('gives billing the documentation and invoicing stages', () => {
    expect(
      authoriseTransition(wf, '07. Pack Ready', '08. Out for signature', billing).allowed,
    ).toBe(true);
    expect(
      authoriseTransition(wf, '08. Out for signature', '09. Awaiting change order', billing)
        .allowed,
    ).toBe(true);
    expect(authoriseTransition(wf, '08. Out for signature', '10. Invoiced', billing).allowed).toBe(
      true,
    );
    expect(authoriseTransition(wf, '10. Invoiced', '11. Partially Invoiced', billing).allowed).toBe(
      true,
    );
  });

  it('stops billing touching execution', () => {
    expect(
      authoriseTransition(wf, '06. Actuals in Progress', '07. Pack Ready', billing).rejection,
    ).toBe('MISSING_PERMISSION');
  });

  it('gives an administrator every legal move', () => {
    for (const t of wf.transitions) {
      expect(authoriseTransition(wf, t.from, t.to, ALL).allowed, `${t.from} -> ${t.to}`).toBe(true);
    }
  });
});

describe('rejections', () => {
  it('rejects a no-op transition', () => {
    expect(checkTransition(wf, '04. WIP', '04. WIP').rejection).toBe('NO_CHANGE');
  });

  it('rejects leaving a terminal status', () => {
    const check = checkTransition(wf, '00. Cancelled', '01. Scoping');
    expect(check.allowed).toBe(false);
    expect(check.rejection).toBe('TERMINAL');
  });

  it('rejects an unknown status', () => {
    expect(checkTransition(wf, '04. WIP' as JobStatus, '99. Nonsense' as JobStatus).rejection).toBe(
      'UNKNOWN_STATUS',
    );
  });

  it('always supplies a human-readable reason', () => {
    const results = [
      checkTransition(wf, '01. Scoping', '10. Invoiced'),
      checkTransition(wf, '00. Cancelled', '01. Scoping'),
      checkTransition(wf, '04. WIP', '04. WIP'),
      authoriseTransition(wf, '01. Scoping', '01A. Scoped', new Set()),
    ];
    for (const r of results) {
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('backward detection', () => {
  it('identifies true backward moves', () => {
    expect(isBackward(wf, '06. Actuals in Progress', '04. WIP')).toBe(true);
    expect(isBackward(wf, '04. WIP', '06. Actuals in Progress')).toBe(false);
  });

  it('never treats cancellation as backward', () => {
    expect(isBackward(wf, '10. Invoiced', '00. Cancelled')).toBe(false);
  });

  it('handles the documented rewinds', () => {
    expect(isBackward(wf, '01A. Scoped', '01. Scoping')).toBe(true);
    expect(isBackward(wf, '09. Awaiting change order', '04. WIP')).toBe(true);
  });
});

describe('planning and actuals locks', () => {
  it('allows planned edits only up to Awaiting PO', () => {
    expect(canEditPlanned(wf, '01. Scoping')).toBe(true);
    expect(canEditPlanned(wf, '01A. Scoped')).toBe(true);
    expect(canEditPlanned(wf, '02. Awaiting PO')).toBe(true);
  });

  it('freezes planned quantities once the job is released', () => {
    for (const status of [
      '03. WNYS',
      '04. WIP',
      '05. Work Complete',
      '06. Actuals in Progress',
      '07. Pack Ready',
      '08. Out for signature',
      '09. Awaiting change order',
      '10. Invoiced',
      '11. Partially Invoiced',
    ] as JobStatus[]) {
      expect(canEditPlanned(wf, status), status).toBe(false);
    }
    expect(canEditPlanned(wf, '00. Cancelled')).toBe(false);
  });

  it('explains why planning is frozen', () => {
    expect(plannedLockReason(wf, '04. WIP')).toContain('02. Awaiting PO');
    expect(plannedLockReason(wf, '00. Cancelled')?.toLowerCase()).toContain('terminal');
    expect(plannedLockReason(wf, '01. Scoping')).toBeNull();
  });

  it('allows actuals only during execution', () => {
    expect(canEditActuals(wf, '04. WIP')).toBe(true);
    expect(canEditActuals(wf, '05. Work Complete')).toBe(true);
    expect(canEditActuals(wf, '06. Actuals in Progress')).toBe(true);
  });

  it('refuses actuals outside execution', () => {
    for (const status of [
      '01. Scoping',
      '01A. Scoped',
      '02. Awaiting PO',
      '03. WNYS',
      '07. Pack Ready',
      '08. Out for signature',
      '10. Invoiced',
      '00. Cancelled',
    ] as JobStatus[]) {
      expect(canEditActuals(wf, status), status).toBe(false);
    }
    expect(actualsLockReason(wf, '07. Pack Ready')).toContain('06. Actuals in Progress');
  });
});

/**
 * Item 5's whole point: none of the answers above may come from a constant.
 * These use a deliberately mutated workflow and assert the engine follows it.
 */
describe('the engine follows the workflow it is given', () => {
  const withoutCancellationFromWip: JobWorkflow = {
    ...wf,
    transitions: wf.transitions.filter((t) => !(t.from === '04. WIP' && t.to === '00. Cancelled')),
  };

  it('refuses a cancellation edge the catalogue does not contain', () => {
    expect(checkTransition(withoutCancellationFromWip, '04. WIP', '00. Cancelled').rejection).toBe(
      'ILLEGAL',
    );
    expect(
      checkTransition(withoutCancellationFromWip, '05. Work Complete', '00. Cancelled').allowed,
    ).toBe(true);
  });

  it('honours a changed capability on an edge', () => {
    const billingMayExecute: JobWorkflow = {
      ...wf,
      transitions: wf.transitions.map((t) =>
        t.from === '03. WNYS' && t.to === '04. WIP'
          ? { ...t, permission: 'job.transition.billing' }
          : t,
      ),
    };

    expect(
      authoriseTransition(billingMayExecute, '03. WNYS', '04. WIP', perms('job.transition.billing'))
        .allowed,
    ).toBe(true);
    expect(
      authoriseTransition(billingMayExecute, '03. WNYS', '04. WIP', perms('job.transition.execute'))
        .rejection,
    ).toBe('MISSING_PERMISSION');
  });

  it('reads labels, not keys, in the messages it builds', () => {
    const relabelled: JobWorkflow = {
      ...wf,
      statuses: wf.statuses.map((status) =>
        status.key === '04. WIP' ? { ...status, label: 'Work in progress' } : status,
      ),
    };

    expect(checkTransition(relabelled, '04. WIP', '04. WIP').reason).toContain('Work in progress');
    expect(actualsLockReason(relabelled, '07. Pack Ready')).toContain('Work in progress');
    expect(jobStatusLabel(relabelled, '04. WIP')).toBe('Work in progress');
  });

  it('moves "backward" when an administrator moves a status', () => {
    const reordered: JobWorkflow = {
      ...wf,
      statuses: wf.statuses.map((status) =>
        status.key === '04. WIP'
          ? { ...status, sortOrder: 20 }
          : status.key === '05. Work Complete'
            ? { ...status, sortOrder: 5 }
            : status,
      ),
    };

    expect(isBackward(wf, '05. Work Complete', '04. WIP')).toBe(true);
    expect(isBackward(reordered, '05. Work Complete', '04. WIP')).toBe(false);
  });

  it('follows the editable flags, including the lock message', () => {
    const planningOnly: JobWorkflow = {
      ...wf,
      statuses: wf.statuses.map((status) => ({
        ...status,
        editablePlanned: status.key === '07. Pack Ready',
        editableActuals: false,
      })),
    };

    expect(canEditPlanned(planningOnly, '07. Pack Ready')).toBe(true);
    expect(canEditPlanned(planningOnly, '01. Scoping')).toBe(false);
    expect(plannedLockReason(planningOnly, '01. Scoping')).toContain('07. Pack Ready');
    expect(actualsLockReason(planningOnly, '04. WIP')).toContain('no status');
  });

  it('treats a status an administrator marked terminal as an exit', () => {
    const paidIsTerminal: JobWorkflow = {
      ...wf,
      statuses: wf.statuses.map((status) =>
        status.key === '11. Partially Invoiced' ? { ...status, isTerminal: true } : status,
      ),
      transitions: wf.transitions.filter((t) => t.from !== '11. Partially Invoiced'),
    };

    expect(
      checkTransition(paidIsTerminal, '11. Partially Invoiced', '00. Cancelled').rejection,
    ).toBe('TERMINAL');
    expect(isBackward(paidIsTerminal, '10. Invoiced', '11. Partially Invoiced')).toBe(false);
  });
});
