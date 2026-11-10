/**
 * Lightweight Prometheus metrics registry and collector (Step 2).
 *
 * Exposes application telemetry and system health in standard Prometheus
 * exposition text format without requiring external dependencies.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { auditFailureCount } from '../audit/service.js';
import { isS3Active } from '../storage/index.js';
import { onlineUserIds } from '../chat/events.js';

const MAX_METRIC_KEYS = 2000;
const requestCounts = new Map<string, number>();

export function recordHttpRequest(method: string, route: string, statusCode: number): void {
  const normalizedMethod = method.toUpperCase();
  const normalizedRoute = (route.split('?')[0] || '/').replace(/["\\\n\r]/g, '');
  const key = `${normalizedMethod}|${normalizedRoute}|${statusCode}`;
  if (!requestCounts.has(key) && requestCounts.size >= MAX_METRIC_KEYS) {
    const overflowKey = `${normalizedMethod}|__overflow__|${statusCode}`;
    if (!requestCounts.has(overflowKey) && requestCounts.size >= MAX_METRIC_KEYS + 64) {
      return;
    }
    requestCounts.set(overflowKey, (requestCounts.get(overflowKey) ?? 0) + 1);
    return;
  }
  requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
}

export function resetMetrics(): void {
  requestCounts.clear();
}

export function generatePrometheusMetrics(): string {
  const lines: string[] = [];

  // 1. Process uptime
  lines.push('# HELP process_uptime_seconds The uptime of the Node.js process in seconds.');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${process.uptime().toFixed(2)}`);

  // 2. Memory usage
  const memory = process.memoryUsage();
  lines.push('# HELP process_resident_memory_bytes Resident memory size in bytes.');
  lines.push('# TYPE process_resident_memory_bytes gauge');
  lines.push(`process_resident_memory_bytes ${memory.rss}`);

  lines.push('# HELP process_heap_bytes Process heap memory usage in bytes.');
  lines.push('# TYPE process_heap_bytes gauge');
  lines.push(`process_heap_bytes{type="used"} ${memory.heapUsed}`);
  lines.push(`process_heap_bytes{type="total"} ${memory.heapTotal}`);

  // 3. HTTP requests
  lines.push('# HELP http_requests_total Total number of HTTP requests processed.');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, count] of requestCounts) {
    const [method, route, statusCode] = key.split('|');
    lines.push(
      `http_requests_total{method="${method}",route="${route}",status="${statusCode}"} ${count}`,
    );
  }

  // 4. Domain Metrics
  lines.push('# HELP openerp_audit_failures_total Total number of failed write audit entries.');
  lines.push('# TYPE openerp_audit_failures_total counter');
  lines.push(`openerp_audit_failures_total ${auditFailureCount()}`);

  lines.push(
    '# HELP openerp_storage_s3_active 1 if S3/Garage storage client is configured, 0 if using DB byte fallback.',
  );
  lines.push('# TYPE openerp_storage_s3_active gauge');
  lines.push(`openerp_storage_s3_active ${isS3Active() ? 1 : 0}`);

  lines.push('# HELP openerp_chat_active_listeners Number of active online user chat streams.');
  lines.push('# TYPE openerp_chat_active_listeners gauge');
  lines.push(`openerp_chat_active_listeners ${onlineUserIds().length}`);

  return lines.join('\n') + '\n';
}

async function metricsHandler(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
  return reply
    .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    .send(generatePrometheusMetrics());
}

export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    const url = request.url;
    if (
      !url.startsWith('/metrics') &&
      !url.startsWith('/health') &&
      !url.startsWith('/api/metrics') &&
      !url.startsWith('/api/health')
    ) {
      // Collapse unmatched/404 paths into a single bucket so automated scanners
      // probing arbitrary URLs cannot grow `requestCounts` without bound.
      const route = request.routeOptions?.url || '__unmatched__';
      recordHttpRequest(request.method, route, reply.statusCode);
    }
    done();
  });

  app.get('/metrics', metricsHandler);
  app.get('/api/metrics', metricsHandler);
}
