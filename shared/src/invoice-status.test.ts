import { describe, expect, it } from 'vitest';
import {
  authoriseInvoiceTransition,
  canDeleteInvoice,
  canEditInvoice,
  checkInvoiceTransition,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  isOpenInvoiceStatus,
  isRecognisedInvoiceStatus,
  isTerminalInvoiceStatus,
  nextInvoiceStatuses,
} from './invoice-status.js';
import type { InvoiceStatus } from './schemas/enums.js';

const perms = (...keys: string[]) => new Set<string>(keys);

/** Billing clerk: the full lifecycle. */
const billing = perms(
  'invoice.read',
  'invoice.write',
  'invoice.submit',
  'invoice.approve',
  'invoice.status',
);

/** QS: may draft and submit, nothing beyond. */
const qs = perms('invoice.read', 'invoice.write', 'invoice.submit');

const pm = perms('project.read', 'job.read');
const supervisor = perms('job.read.assigned', 'deliverable.write.actual');

describe('status catalogue', () => {
  it('defines all 7 statuses', () => {
    expect(INVOICE_STATUSES).toHaveLength(7);
  });

  it('treats Paid and Cancelled as the only terminal statuses', () => {
    expect(isTerminalInvoiceStatus('Paid')).toBe(true);
    expect(isTerminalInvoiceStatus('Cancelled')).toBe(true);
    for (const s of INVOICE_STATUSES.filter((x) => x !== 'Paid' && x !== 'Cancelled')) {
      expect(isTerminalInvoiceStatus(s)).toBe(false);
    }
  });

  it('references only statuses that exist', () => {
    for (const t of INVOICE_TRANSITIONS) {
      expect(INVOICE_STATUSES).toContain(t.from);
      expect(INVOICE_STATUSES).toContain(t.to);
      expect(t.reason.length).toBeGreaterThan(5);
    }
  });

  it('lets an administrator perform every legal move', () => {
    const all = perms('invoice.write', 'invoice.submit', 'invoice.approve', 'invoice.status');
    for (const t of INVOICE_TRANSITIONS) {
      expect(authoriseInvoiceTransition(t.from, t.to, all).allowed, `${t.from} -> ${t.to}`).toBe(
        true,
      );
    }
  });
});

describe('forward pipeline', () => {
  const forward: Array<[InvoiceStatus, InvoiceStatus]> = [
    ['Draft', 'Submitted'],
    ['Submitted', 'Approved'],
    ['Approved', 'Paid'],
    ['Approved', 'Partially Paid'],
    ['Partially Paid', 'Paid'],
    ['Submitted', 'Disputed'],
    ['Approved', 'Disputed'],
    ['Disputed', 'Submitted'],
    ['Disputed', 'Draft'],
    ['Draft', 'Cancelled'],
    ['Submitted', 'Cancelled'],
    ['Approved', 'Cancelled'],
    ['Partially Paid', 'Cancelled'],
    ['Disputed', 'Cancelled'],
  ];

  for (const [from, to] of forward) {
    it(`allows ${from} -> ${to}`, () => {
      expect(checkInvoiceTransition(from, to).allowed).toBe(true);
    });
  }

  it('exposes the legal targets for the UI', () => {
    expect(nextInvoiceStatuses('Draft').sort()).toEqual(['Cancelled', 'Submitted']);
    expect(nextInvoiceStatuses('Paid')).toEqual([]);
  });
});

describe('skips are illegal for everyone', () => {
  it('cannot jump Draft -> Approved, even holding every permission', () => {
    const all = perms('invoice.write', 'invoice.submit', 'invoice.approve', 'invoice.status');
    const check = authoriseInvoiceTransition('Draft', 'Approved', all);
    expect(check.allowed).toBe(false);
    expect(check.rejection).toBe('ILLEGAL');
  });

  it('cannot jump Draft -> Paid', () => {
    expect(checkInvoiceTransition('Draft', 'Paid').rejection).toBe('ILLEGAL');
  });

  it('cannot unpay a paid invoice', () => {
    expect(checkInvoiceTransition('Paid', 'Approved').rejection).toBe('TERMINAL');
    expect(checkInvoiceTransition('Paid', 'Disputed').rejection).toBe('TERMINAL');
  });

  it('cannot resurrect a cancelled invoice', () => {
    expect(checkInvoiceTransition('Cancelled', 'Draft').rejection).toBe('TERMINAL');
  });

  it('cannot record payment against an unapproved invoice', () => {
    expect(checkInvoiceTransition('Submitted', 'Paid').rejection).toBe('ILLEGAL');
    expect(checkInvoiceTransition('Submitted', 'Partially Paid').rejection).toBe('ILLEGAL');
  });

  it('rejects a no-op transition', () => {
    expect(checkInvoiceTransition('Draft', 'Draft').rejection).toBe('NO_CHANGE');
  });
});

describe('role boundaries', () => {
  it('lets billing drive the whole lifecycle', () => {
    for (const [from, to] of [
      ['Draft', 'Submitted'],
      ['Submitted', 'Approved'],
      ['Approved', 'Paid'],
      ['Submitted', 'Cancelled'],
      ['Disputed', 'Submitted'],
    ] as Array<[InvoiceStatus, InvoiceStatus]>) {
      expect(authoriseInvoiceTransition(from, to, billing).allowed, `${from} -> ${to}`).toBe(true);
    }
  });

  it('lets a QS draft and submit, but not approve', () => {
    expect(authoriseInvoiceTransition('Draft', 'Submitted', qs).allowed).toBe(true);
    expect(authoriseInvoiceTransition('Submitted', 'Approved', qs).rejection).toBe(
      'MISSING_PERMISSION',
    );
    expect(authoriseInvoiceTransition('Submitted', 'Approved', qs).requiredPermission).toBe(
      'invoice.approve',
    );
  });

  it('stops a QS cancelling even their own draft', () => {
    // Cancellation is always a billing decision (see the module docstring).
    const check = authoriseInvoiceTransition('Draft', 'Cancelled', qs);
    expect(check.allowed).toBe(false);
    expect(check.rejection).toBe('MISSING_PERMISSION');
    expect(check.requiredPermission).toBe('invoice.status');
  });

  it('lets a QS correct a disputed invoice sent back to draft', () => {
    expect(authoriseInvoiceTransition('Disputed', 'Draft', qs).allowed).toBe(true);
  });

  it('gives the PM and supervisors no invoice moves at all', () => {
    for (const caller of [pm, supervisor]) {
      expect(authoriseInvoiceTransition('Draft', 'Submitted', caller).rejection).toBe(
        'MISSING_PERMISSION',
      );
    }
  });

  it('always explains a refusal', () => {
    const check = authoriseInvoiceTransition('Submitted', 'Approved', qs);
    expect(check.reason.length).toBeGreaterThan(10);
    expect(check.reason).toContain('invoice.approve');
  });
});

describe('open and recognised sets', () => {
  it('treats drafts through disputes as open against the job', () => {
    for (const s of ['Draft', 'Submitted', 'Approved', 'Disputed'] as InvoiceStatus[]) {
      expect(isOpenInvoiceStatus(s), s).toBe(true);
    }
  });

  it('treats only fully settled and cancelled documents as closed', () => {
    for (const s of ['Paid', 'Cancelled'] as InvoiceStatus[]) {
      expect(isOpenInvoiceStatus(s), s).toBe(false);
    }
  });

  it('keeps a part-settled invoice open, or the same lines get billed twice', () => {
    // Regression: Partially Paid was initially excluded from the open set, which
    // let a progress invoice be raised on top of a part-settled one and bill the
    // same actuals twice.
    expect(isOpenInvoiceStatus('Partially Paid')).toBe(true);
  });

  it('allows a part-settled invoice to be written off', () => {
    // Without this, a part-settled invoice could never be closed: Paid is
    // terminal and there was no cancellation edge out of Partially Paid.
    expect(checkInvoiceTransition('Partially Paid', 'Cancelled').allowed).toBe(true);
  });

  it('recognises only approved-or-later documents as billed', () => {
    for (const s of ['Approved', 'Partially Paid', 'Paid'] as InvoiceStatus[]) {
      expect(isRecognisedInvoiceStatus(s), s).toBe(true);
    }
    for (const s of ['Draft', 'Submitted', 'Disputed', 'Cancelled'] as InvoiceStatus[]) {
      expect(isRecognisedInvoiceStatus(s), s).toBe(false);
    }
  });
});

describe('edit and delete guards', () => {
  it('allows edits only on drafts', () => {
    expect(canEditInvoice('Draft')).toBe(true);
    for (const s of INVOICE_STATUSES.filter((x) => x !== 'Draft')) {
      expect(canEditInvoice(s), s).toBe(false);
    }
  });

  it('allows deletion of drafts and cancelled invoices only', () => {
    expect(canDeleteInvoice('Draft')).toBe(true);
    expect(canDeleteInvoice('Cancelled')).toBe(true);
    for (const s of [
      'Submitted',
      'Approved',
      'Partially Paid',
      'Paid',
      'Disputed',
    ] as InvoiceStatus[]) {
      expect(canDeleteInvoice(s), s).toBe(false);
    }
  });
});
