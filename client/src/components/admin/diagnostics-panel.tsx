'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  HardDrive,
  Layers,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { api, type SystemDiagnostics } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function DiagnosticsPanel() {
  const [autoRefresh, setAutoRefresh] = useState(true);

  const diagnosticsQuery = useQuery({
    queryKey: ['admin-diagnostics'],
    queryFn: () => api.get<SystemDiagnostics>('/api/admin/diagnostics'),
    refetchInterval: autoRefresh ? 15_000 : false, // Poll every 15s when auto-refresh is on
  });

  const data = diagnosticsQuery.data;
  const isFetching = diagnosticsQuery.isFetching;

  if (diagnosticsQuery.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
        <span className="sr-only">Loading system diagnostics…</span>
      </div>
    );
  }

  if (diagnosticsQuery.isError || !data) {
    return (
      <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-6 text-center space-y-3">
        <AlertCircle className="mx-auto size-8 text-destructive" />
        <h3 className="font-semibold text-destructive">Failed to Load System Diagnostics</h3>
        <p className="text-xs text-muted-foreground">
          {diagnosticsQuery.error instanceof Error
            ? diagnosticsQuery.error.message
            : 'Could not communicate with the diagnostics endpoint.'}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void diagnosticsQuery.refetch()}
          className="gap-1.5"
        >
          <RefreshCw className="size-3.5" />
          Retry Probe
        </Button>
      </div>
    );
  }

  const allHealthy =
    data.database.status === 'healthy' &&
    (data.storage.status === 'healthy' || data.storage.status === 'disabled') &&
    data.queue.status === 'healthy';

  return (
    <div className="space-y-6">
      {/* Top Controls & Overall Status */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Activity className="size-5 text-primary" />
            System Infrastructure & Diagnostics
          </h2>
          <p className="text-xs text-muted-foreground">
            Live health telemetry for PostgreSQL, Garage S3, background workers, and container runtime.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setAutoRefresh((prev) => !prev)}
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border transition-colors cursor-pointer',
              autoRefresh
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                autoRefresh ? 'bg-primary animate-pulse' : 'bg-muted-foreground',
              )}
            />
            {autoRefresh ? 'Live Auto-Refresh (15s)' : 'Auto-Refresh Paused'}
          </button>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void diagnosticsQuery.refetch()}
            disabled={isFetching}
            className="gap-1.5 text-xs h-7.5 rounded-lg border-border/80"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Global Status Banner */}
      <div
        className={cn(
          'rounded-2xl border p-4 flex items-center justify-between gap-4 transition-all',
          allHealthy
            ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200',
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'flex size-9 items-center justify-center rounded-xl',
              allHealthy
                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
            )}
          >
            {allHealthy ? (
              <CheckCircle2 className="size-5" />
            ) : (
              <AlertTriangle className="size-5" />
            )}
          </div>
          <div>
            <h4 className="text-sm font-semibold">
              {allHealthy
                ? 'All Infrastructure Subsystems Operational'
                : 'Subsystem Attention Required'}
            </h4>
            <p className="text-xs opacity-85">
              {allHealthy
                ? 'Database connection pool, object storage, and background task runner are responding normally.'
                : 'One or more subsystem probes reported warnings or elevated latency.'}
            </p>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-3 text-right">
          <div className="text-[11px] font-mono opacity-75">
            Probe: {new Date(data.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {/* 4 Primary Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 1. PostgreSQL Database */}
        <Card className="rounded-2xl border-border/80 bg-card/80 backdrop-blur-sm shadow-sm space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
                <Database className="size-5" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">PostgreSQL Database</CardTitle>
                <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                  {data.database.version}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5',
                  data.database.latencyMs < 50
                    ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                    : 'border-amber-500/30 text-amber-600 dark:text-amber-400 bg-amber-500/10',
                )}
              >
                {data.database.latencyMs} ms
              </Badge>
              <Badge
                variant={data.database.status === 'healthy' ? 'default' : 'destructive'}
                className="text-[10px] uppercase font-semibold tracking-wider"
              >
                {data.database.status}
              </Badge>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-border/60 text-xs">
            <div className="flex items-center justify-between text-muted-foreground">
              <span>Connection Pool Utilization</span>
              <span className="font-mono font-medium text-foreground">
                {data.database.pool.totalCount - data.database.pool.idleCount} active /{' '}
                {data.database.pool.maxConnections} max
              </span>
            </div>

            {/* Pool utilization bar */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    Math.round(
                      ((data.database.pool.totalCount - data.database.pool.idleCount) /
                        data.database.pool.maxConnections) *
                        100,
                    ),
                  )}%`,
                }}
              />
            </div>

            <div className="grid grid-cols-3 gap-2 pt-2 text-[11px] font-mono text-center">
              <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
                <span className="block text-muted-foreground text-[10px]">Idle Conns</span>
                <span className="font-semibold text-foreground">
                  {data.database.pool.idleCount}
                </span>
              </div>
              <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
                <span className="block text-muted-foreground text-[10px]">Waiting</span>
                <span className="font-semibold text-foreground">
                  {data.database.pool.waitingCount}
                </span>
              </div>
              <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
                <span className="block text-muted-foreground text-[10px]">DB Size</span>
                <span className="font-semibold text-foreground">{data.database.size}</span>
              </div>
            </div>
          </div>
        </Card>

        {/* 2. Object Storage (Garage S3) */}
        <Card className="rounded-2xl border-border/80 bg-card/80 backdrop-blur-sm shadow-sm space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-violet-500/10 text-violet-600 dark:text-violet-400">
                <HardDrive className="size-5" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Object Storage (Garage S3)</CardTitle>
                <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                  Bucket: {data.storage.bucket}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {data.storage.latencyMs !== null && (
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono px-2 py-0.5 border-violet-500/30 text-violet-600 dark:text-violet-400 bg-violet-500/10"
                >
                  {data.storage.latencyMs} ms
                </Badge>
              )}
              <Badge
                variant={
                  data.storage.status === 'healthy'
                    ? 'default'
                    : data.storage.status === 'disabled'
                      ? 'secondary'
                      : 'destructive'
                }
                className="text-[10px] uppercase font-semibold tracking-wider"
              >
                {data.storage.status}
              </Badge>
            </div>
          </div>

          <div className="space-y-2 pt-2 border-t border-border/60 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Endpoint</span>
              <span className="font-mono text-[11px] text-foreground truncate max-w-[200px]">
                {data.storage.endpoint ?? 'Not configured'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Client State</span>
              <span className="font-medium text-foreground">
                {data.storage.active ? 'S3 Driver Initialized' : 'Local Fallback'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Bucket Probe</span>
              <span
                className={cn(
                  'font-medium',
                  data.storage.reachable ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
                )}
              >
                {data.storage.reachable ? 'Bucket Accessible' : 'Unreachable / Inactive'}
              </span>
            </div>
            {data.storage.error && (
              <p className="text-[11px] text-destructive font-mono pt-1 break-all">
                {data.storage.error}
              </p>
            )}
          </div>
        </Card>

        {/* 3. Background Job Queue (pg-boss) */}
        <Card className="rounded-2xl border-border/80 bg-card/80 backdrop-blur-sm shadow-sm space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
                <Layers className="size-5" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Background Queue (pg-boss)</CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  Asynchronous PDF generation & scheduled jobs
                </p>
              </div>
            </div>

            <Badge
              variant={data.queue.status === 'healthy' ? 'default' : 'secondary'}
              className="text-[10px] uppercase font-semibold tracking-wider"
            >
              {data.queue.status}
            </Badge>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-2 border-t border-border/60 text-[11px] font-mono text-center">
            <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
              <span className="block text-muted-foreground text-[10px]">Active Jobs</span>
              <span className="font-semibold text-foreground">{data.queue.activeJobs}</span>
            </div>
            <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
              <span className="block text-muted-foreground text-[10px]">Completed</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {data.queue.completedJobs}
              </span>
            </div>
            <div className="rounded-lg bg-muted/40 p-2 border border-border/50">
              <span className="block text-muted-foreground text-[10px]">Dead Letter</span>
              <span
                className={cn(
                  'font-semibold',
                  data.queue.failedJobs > 0 ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {data.queue.failedJobs}
              </span>
            </div>
          </div>
        </Card>

        {/* 4. Container Runtime & Memory */}
        <Card className="rounded-2xl border-border/80 bg-card/80 backdrop-blur-sm shadow-sm space-y-4 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                <Server className="size-5" />
              </div>
              <div>
                <CardTitle className="text-sm font-semibold">Node.js Runtime & Process</CardTitle>
                <p className="text-[11px] text-muted-foreground truncate max-w-[200px]">
                  {data.nodeVersion} · {data.platform}
                </p>
              </div>
            </div>

            <Badge variant="outline" className="text-[10px] font-mono px-2 py-0.5">
              v{data.version}
            </Badge>
          </div>

          <div className="space-y-2 pt-2 border-t border-border/60 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Clock className="size-3.5" />
                Uptime
              </span>
              <span className="font-medium text-foreground">
                {formatUptime(data.uptimeSeconds)}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <Cpu className="size-3.5" />
                Memory (Heap / RSS)
              </span>
              <span className="font-mono text-foreground">
                {data.memory.heapUsedMb} MB / {data.memory.rssMb} MB
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center gap-1.5">
                <ShieldCheck className="size-3.5" />
                Audit Trail Integrity
              </span>
              <span
                className={cn(
                  'font-medium text-xs',
                  data.audit.failuresCount === 0
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-destructive',
                )}
              >
                {data.audit.failuresCount === 0 ? '0 Write Failures (Healthy)' : `${data.audit.failuresCount} Failures Detected`}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
