import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ServiceCodeRecipeBuilder } from './ServiceCodeRecipeBuilder';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderWithClient(ui: React.ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe('ServiceCodeRecipeBuilder Component', () => {
  it('renders initial state prompting user to select a service code', () => {
    const html = renderWithClient(
      <ServiceCodeRecipeBuilder amendmentId={1} canEdit={true} />,
    );

    expect(html).toContain('Service codes');
    expect(html).toContain('Select a service code to edit its recipe.');
  });

  it('renders correctly in read-only mode for viewer accounts', () => {
    const html = renderWithClient(
      <ServiceCodeRecipeBuilder amendmentId={1} canEdit={false} />,
    );

    expect(html).toContain('Service codes');
    // In read-only mode, Add service code trigger is not visible
    expect(html).not.toContain('Add service code');
  });
});
