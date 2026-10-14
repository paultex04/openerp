import { describe, expect, it } from 'vitest';
import {
  actualsLockReason,
  allNextStatuses,
  authoriseTransition,
  canEditActuals,
  canEditPlanned,
  checkTransition,
  isBackward,
  isTerminal,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  plannedLockReason,
} from './job-status';
import type { JobStatus } from './schemas/enums';

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

describe('status catalogue', () => {
  it('defines all 13 statuses', () => {
    expect(JOB_STATUSES).toHaveLength(13);
  });

  it('treats Cancelled as the only terminal status', () => {
    expect(isTerminal('00. Cancelled')).toBe(true);
    for (const status of JOB_STATUSES.filter((s) => s !== '00. Cancelled')) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it('offers cancellation from every non-terminal status', () => {
    for (const status of JOB_STATUSES.filter((s) => s !== '00. Cancelled')) {
      expect(allNextStatuses(status)).toContain('00. Cancelled');
    }
    expect(allNextStatuses('00. Cancelled')).toEqual([]);
  });

  it('references only statuses that exist', () => {
    for (const t of JOB_TRANSITIONS) {
      expect(JOB_STATUSES).toContain(t.from);
      expect(JOB_STATUSES).toContain(t.to);
      expect(t.reason.length).toBeGreaterThan(5);
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
      expect(checkTransition(from, to).allowed).toBe(true);
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
      const check = checkTransition(from, to);
      expect(check.allowed, `${from} -> ${to} must be illegal for anyone`).toBe(false);
      expect(check.rejection).toBe('ILLEGAL');
    }
  });

  it('cannot jump directly from 01. Scoping to 10. Invoiced', () => {
    const check = authoriseTransition('01. Scoping', '10. Invoiced', supervisor);
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
      expect(checkTransition('01. Scoping', to).allowed, `01 -> ${to}`).toBe(false);
    }
  });

  it('cannot touch the scoping stages at all', () => {
    expect(authoriseTransition('01. Scoping', '01A. Scoped', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
    expect(authoriseTransition('01A. Scoped', '02. Awaiting PO', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('cannot invoice, regardless of how it reaches pack ready', () => {
    expect(authoriseTransition('07. Pack Ready', '10. Invoiced', supervisor).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('cannot cancel a job', () => {
    expect(authoriseTransition('04. WIP', '00. Cancelled', supervisor).rejection).toBe(
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
      expect(authoriseTransition(from, to, supervisor).allowed, `${from} -> ${to}`).toBe(true);
    }
  });

  it('CAN execute a change order back into WIP', () => {
    expect(authoriseTransition('09. Awaiting change order', '04. WIP', supervisor).allowed).toBe(
      true,
    );
  });
});

describe('role boundaries', () => {
  const pm = perms('job.transition.scope');
  const billing = perms('job.transition.billing', 'job.transition.invoice');

  it('gives the PM the scoping stages only', () => {
    expect(authoriseTransition('01. Scoping', '01A. Scoped', pm).allowed).toBe(true);
    expect(authoriseTransition('01A. Scoped', '02. Awaiting PO', pm).allowed).toBe(true);
    // Execution belongs to the supervisor from here on.
    expect(authoriseTransition('02. Awaiting PO', '03. WNYS', pm).rejection).toBe(
      'MISSING_PERMISSION',
    );
  });

  it('lets the PM reopen scoping', () => {
    expect(authoriseTransition('01A. Scoped', '01. Scoping', pm).allowed).toBe(true);
  });

  it('gives billing the documentation and invoicing stages', () => {
    expect(authoriseTransition('07. Pack Ready', '08. Out for signature', billing).allowed).toBe(
      true,
    );
    expect(
      authoriseTransition('08. Out for signature', '09. Awaiting change order', billing).allowed,
    ).toBe(true);
    expect(authoriseTransition('08. Out for signature', '10. Invoiced', billing).allowed).toBe(
      true,
    );
    expect(authoriseTransition('10. Invoiced', '11. Partially Invoiced', billing).allowed).toBe(
      true,
    );
  });

  it('stops billing touching execution', () => {
    expect(
      authoriseTransition('06. Actuals in Progress', '07. Pack Ready', billing).rejection,
    ).toBe('MISSING_PERMISSION');
  });

  it('gives an administrator every legal move', () => {
    for (const t of JOB_TRANSITIONS) {
      expect(authoriseTransition(t.from, t.to, ALL).allowed, `${t.from} -> ${t.to}`).toBe(true);
    }
    expect(authoriseTransition('04. WIP', '00. Cancelled', ALL).allowed).toBe(true);
  });
});

describe('rejections', () => {
  it('rejects a no-op transition', () => {
    expect(checkTransition('04. WIP', '04. WIP').rejection).toBe('NO_CHANGE');
  });

  it('rejects leaving a terminal status', () => {
    const check = checkTransition('00. Cancelled', '01. Scoping');
    expect(check.allowed).toBe(false);
    expect(check.rejection).toBe('TERMINAL');
  });

  it('rejects an unknown status', () => {
    expect(checkTransition('04. WIP' as JobStatus, '99. Nonsense' as JobStatus).rejection).toBe(
      'UNKNOWN_STATUS',
    );
  });

  it('always supplies a human-readable reason', () => {
    const results = [
      checkTransition('01. Scoping', '10. Invoiced'),
      checkTransition('00. Cancelled', '01. Scoping'),
      checkTransition('04. WIP', '04. WIP'),
      authoriseTransition('01. Scoping', '01A. Scoped', new Set()),
    ];
    for (const r of results) {
      expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('backward detection', () => {
  it('identifies true backward moves', () => {
    expect(isBackward('06. Actuals in Progress', '04. WIP')).toBe(true);
    expect(isBackward('04. WIP', '06. Actuals in Progress')).toBe(false);
  });

  it('never treats cancellation as backward', () => {
    expect(isBackward('10. Invoiced', '00. Cancelled')).toBe(false);
  });

  it('handles the documented rewinds', () => {
    expect(isBackward('01A. Scoped', '01. Scoping')).toBe(true);
    expect(isBackward('09. Awaiting change order', '04. WIP')).toBe(true);
  });
});

describe('planning and actuals locks', () => {
  it('allows planned edits only up to Awaiting PO', () => {
    expect(canEditPlanned('01. Scoping')).toBe(true);
    expect(canEditPlanned('01A. Scoped')).toBe(true);
    expect(canEditPlanned('02. Awaiting PO')).toBe(true);
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
      expect(canEditPlanned(status), status).toBe(false);
    }
    expect(canEditPlanned('00. Cancelled')).toBe(false);
  });

  it('explains why planning is frozen', () => {
    expect(plannedLockReason('04. WIP')).toContain('02. Awaiting PO');
    expect(plannedLockReason('00. Cancelled')).toContain('cancelled');
    expect(plannedLockReason('01. Scoping')).toBeNull();
  });

  it('allows actuals only during execution', () => {
    expect(canEditActuals('04. WIP')).toBe(true);
    expect(canEditActuals('05. Work Complete')).toBe(true);
    expect(canEditActuals('06. Actuals in Progress')).toBe(true);
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
      expect(canEditActuals(status), status).toBe(false);
    }
    expect(actualsLockReason('07. Pack Ready')).toContain('06. Actuals in Progress');
  });
});
