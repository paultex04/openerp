import { describe, expect, it, beforeEach } from 'vitest';
import {
  recordHttpRequest,
  resetMetrics,
  generatePrometheusMetrics,
} from './index.js';

describe('Prometheus metrics collector', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('records request counts and generates standard Prometheus output', () => {
    recordHttpRequest('GET', '/api/clients', 200);
    recordHttpRequest('GET', '/api/clients', 200);
    recordHttpRequest('POST', '/api/invoices', 201);
    recordHttpRequest('GET', '/api/unknown', 404);

    const output = generatePrometheusMetrics();

    expect(output).toContain('# HELP process_uptime_seconds');
    expect(output).toContain('# TYPE process_uptime_seconds gauge');
    expect(output).toContain('process_uptime_seconds');

    expect(output).toContain('# HELP http_requests_total');
    expect(output).toContain('http_requests_total{method="GET",route="/api/clients",status="200"} 2');
    expect(output).toContain('http_requests_total{method="POST",route="/api/invoices",status="201"} 1');
    expect(output).toContain('http_requests_total{method="GET",route="/api/unknown",status="404"} 1');

    expect(output).toContain('openerp_audit_failures_total');
    expect(output).toContain('openerp_storage_s3_active');
    expect(output).toContain('openerp_chat_active_listeners');
  });

  it('normalizes routes by stripping query parameters', () => {
    recordHttpRequest('GET', '/api/clients?search=acme&includeArchived=true', 200);

    const output = generatePrometheusMetrics();
    expect(output).toContain('http_requests_total{method="GET",route="/api/clients",status="200"} 1');
    expect(output).not.toContain('search=acme');
  });
});
