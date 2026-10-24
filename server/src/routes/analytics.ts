/**
 * Executive and Financial Analytics Routes (Phase 4).
 *
 * Exposes roll-up aggregations for the Executive Dashboard:
 *  - Trailing 12-month revenue trend
 *  - Work-In-Progress (WIP) valuation
 *  - Gross margin metrics
 *  - SARS VAT liabilities
 *  - Pipeline funnel and amendment expiries
 *
 * Commercial metrics are gated on `invoice.read`; users lacking commercial authority
 * (such as site supervisors) receive operational metrics only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getDashboardAnalytics } from '../analytics/service.js';

export async function registerAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/analytics/dashboard',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const hasCommercial = Boolean(request.principal?.permissions.has('invoice.read'));
      const analytics = await getDashboardAnalytics({
        includeFinancials: hasCommercial,
      });
      return analytics;
    },
  );
}
