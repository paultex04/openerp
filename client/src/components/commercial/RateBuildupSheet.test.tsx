import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RateBuildupSheet } from './RateBuildupSheet';
import type { AmendmentCostParameters } from '@openerp/shared';
import type { RateCardRow } from '@/lib/api';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithClient(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

const mockEngine: AmendmentCostParameters = {
  overheadPct: 0.12,
  sgaPct: 0.08,
  profitPct: 0.095,
  equipmentHourlyRate: 25.5,
  ppePerHour: 8.2,
  transportHourlyRate: 14.0,
  r1MaterialMarkupPct: 0.15,
};

const mockRateCard: RateCardRow = {
  id: 101,
  amendmentId: 1,
  serviceMasterCode: 'LB-ELEC-01',
  labourType: 'Senior Electrician',
  shiftType: 'NT',
  uom: 'per Hour',
  bargainingCouncilDesc: 'MEIBC Rate Table A',
  councilRate: 85.0,
  customRate: null,
  wagePremiumPct: 0.1,
  manInPocket: 93.5,
  leavePay: 7.5,
  totalStatutoryCost: 15.0,
  ppeCost: 8.2,
  transportCost: 14.0,
  equipmentCost: 25.5,
  overheadCost: 19.64,
  sgaCost: 14.67,
  profitCost: 18.86,
  fullLoadedRate: 216.87,
};

describe('RateBuildupSheet Component', () => {
  it('renders blank creation form when isCreating is true', () => {
    const html = renderWithClient(
      <RateBuildupSheet
        amendmentId={1}
        engine={mockEngine}
        selected={null}
        canEdit={true}
        isCreating={true}
      />,
    );

    expect(html).toContain('New labour master rate card');
    expect(html).toContain('Service master code');
    expect(html).toContain('Labour type / Trade');
    expect(html).toContain('Shift type');
    expect(html).toContain('Unit of measure');
  });

  it('renders populated rate card details correctly', () => {
    const html = renderWithClient(
      <RateBuildupSheet
        amendmentId={1}
        engine={mockEngine}
        selected={mockRateCard}
        canEdit={false}
      />,
    );

    expect(html).toContain('LB-ELEC-01');
    expect(html).toContain('Senior Electrician');
    expect(html).toContain('Base direct labour');
    expect(html).toContain('Overhead cost');
    expect(html).toContain('Full loaded rate');
  });

  it('surfaces ADR-001 parameter-derived comparison banner', () => {
    const html = renderWithClient(
      <RateBuildupSheet
        amendmentId={1}
        engine={mockEngine}
        selected={mockRateCard}
        canEdit={true}
      />,
    );

    expect(html).toContain('Parameter-derived comparison');
    expect(html).toContain('Re-deriving overheads from this amendment’s parameters');
  });

  it('handles custom rate vs council rate selection', () => {
    const customCard: RateCardRow = {
      ...mockRateCard,
      id: 102,
      serviceMasterCode: 'LB-SPEC-02',
      labourType: 'Specialist Instrument Artisan',
      councilRate: null,
      customRate: 150.0,
    };

    const html = renderWithClient(
      <RateBuildupSheet
        amendmentId={1}
        engine={mockEngine}
        selected={customCard}
        canEdit={true}
      />,
    );

    expect(html).toContain('Specialist Instrument Artisan');
    expect(html).toContain('150');
  });
});
