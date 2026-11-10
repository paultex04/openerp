import { describe, expect, it, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  recordHttpRequest,
  resetMetrics,
  generatePrometheusMetrics,
  registerMetrics,
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
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/clients",status="200"} 2',
    );
    expect(output).toContain(
      'http_requests_total{method="POST",route="/api/invoices",status="201"} 1',
    );
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/unknown",status="404"} 1',
    );

    expect(output).toContain('openerp_audit_failures_total');
    expect(output).toContain('openerp_storage_s3_active');
    expect(output).toContain('openerp_chat_active_listeners');
  });

  it('normalizes routes by stripping query parameters', () => {
    recordHttpRequest('GET', '/api/clients?search=acme&includeArchived=true', 200);

    const output = generatePrometheusMetrics();
    expect(output).toContain(
      'http_requests_total{method="GET",route="/api/clients",status="200"} 1',
    );
    expect(output).not.toContain('search=acme');
  });

  it('caps unique route cardinality to prevent unbounded memory growth', () => {
    for (let i = 0; i < 2100; i++) {
      recordHttpRequest('GET', `/api/scan/${i}`, 404);
    }

    const output = generatePrometheusMetrics();
    expect(output).toContain(
      'http_requests_total{method="GET",route="__overflow__",status="404"} 100',
    );
    expect(output).not.toContain('/api/scan/2050');
  });

  it('collapses unmatched 404 routes into a single __unmatched__ bucket', async () => {
    const app = Fastify();
    registerMetrics(app);
    app.get('/api/known', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/api/known' });
    await app.inject({ method: 'GET', url: '/wp-login.php' });
    await app.inject({ method: 'GET', url: '/.env' });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain(
      'http_requests_total{method="GET",route="/api/known",status="200"} 1',
    );
    expect(res.body).toContain(
      'http_requests_total{method="GET",route="__unmatched__",status="404"} 2',
    );
    expect(res.body).not.toContain('/wp-login.php');
    expect(res.body).not.toContain('/.env');

    await app.close();
  });
});
