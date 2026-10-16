/**
 * PATCH schemas must not resurrect create-time defaults.
 *
 * The defect this pins (Phase 15): zod applies a field's `.default()` even
 * through `.partial()`, so a partial update that omitted a defaulted field
 * still parsed to the default and the route wrote it over the stored value.
 * `isVatRegistered` flipped VAT-exempt clients back to registered;
 * amendment edits reset custom VAT rates to 0.15 and service-code edits reset
 * `category`/`materialMarkupPct`. `jobUpdateSchema` was hand-declared for the
 * same reason years earlier; these schemas now correct their own defaults.
 *
 * The assertions are written as "key absent", not "value undefined", because
 * absence is exactly what the route guards key on (`body.x !== undefined`);
 * a present-but-undefined key would still write. Absence is the shape that
 * cannot regress.
 */
import { describe, expect, it } from 'vitest';
import {
  amendmentUpdateSchema,
  amendmentUpsertSchema,
  clientUpdateSchema,
  clientUpsertSchema,
  serviceCodeUpdateSchema,
  serviceCodeUpsertSchema,
} from './commercial';

describe('partial update schemas keep PATCH semantics', () => {
  it('client update: omitting isVatRegistered leaves the key absent', () => {
    const parsed = clientUpdateSchema.parse({ name: 'Acme' });
    expect('isVatRegistered' in parsed).toBe(false);
    expect('vatNumber' in parsed).toBe(false);
  });

  it('client create: isVatRegistered still defaults to true', () => {
    const parsed = clientUpsertSchema.parse({ name: 'Acme', email: 'acme@example.test' });
    expect(parsed.isVatRegistered).toBe(true);
  });

  it('amendment update: omitting the defaulted trio leaves all three absent', () => {
    const parsed = amendmentUpdateSchema.parse({ amendmentNumber: 'AMD-1' });
    expect('amendmentType' in parsed).toBe(false);
    expect('status' in parsed).toBe(false);
    expect('vatRate' in parsed).toBe(false);
  });

  it('amendment create: the three defaults still apply', () => {
    const parsed = amendmentUpsertSchema.parse({
      contractId: 1,
      amendmentNumber: 'AMD-1',
      effectiveDate: '2026-01-01',
    });
    expect(parsed.amendmentType).toBe('Annual Escalation');
    expect(parsed.status).toBe('Active');
    expect(parsed.vatRate).toBe(0.15);
  });

  it('service code update: omitting the defaulted pair leaves both absent', () => {
    const parsed = serviceCodeUpdateSchema.parse({ uom: 'M' });
    expect('category' in parsed).toBe(false);
    expect('materialMarkupPct' in parsed).toBe(false);
  });

  it('service code create: the pair still defaults', () => {
    const parsed = serviceCodeUpsertSchema.parse({
      amendmentId: 1,
      code: 'X1',
      description: 'Fixture',
      uom: 'M',
    });
    expect(parsed.category).toBe('Activity');
    expect(parsed.materialMarkupPct).toBe(0);
  });
});
