/**
 * PostgreSQL-backed background job queue via pg-boss (Step 3).
 *
 * Provides resilient, transactional background job execution (asynchronous
 * invoice exports, timesheet reports, and maintenance) without requiring Redis.
 *
 * - In test environments or when unconfigured, falls back to an in-memory runner
 *   so unit tests run without requiring database connectivity.
 * - In production, uses PostgreSQL SKIP LOCKED concurrency.
 */
import { PgBoss } from 'pg-boss';
import type { Config } from '../config.js';

let bossInstance: PgBoss | null = null;
let isStarted = false;

// In-memory fallback mock for test mode
type JobHandler<T = unknown> = (job: { id: string; name: string; data: T }) => Promise<void>;
const testWorkers = new Map<string, JobHandler<any>>();
const testJobs: Array<{ id: string; name: string; data: unknown }> = [];

export function isQueueActive(): boolean {
  return isStarted;
}

export async function initJobQueue(config: Config): Promise<void> {
  if (config.isTest || !config.DATABASE_URL) {
    isStarted = true;
    return;
  }

  try {
    const boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      max: 4, // lightweight pool
    });

    boss.on('error', (err: unknown) => {
      console.error('[pg-boss:error] Background job queue error:', err);
    });

    await boss.start();
    bossInstance = boss;
    isStarted = true;
  } catch (err: unknown) {
    console.error('[pg-boss:boot] Failed to initialize background job queue:', err);
    bossInstance = null;
    isStarted = false;
  }
}

export async function stopJobQueue(): Promise<void> {
  isStarted = false;
  testWorkers.clear();
  testJobs.length = 0;

  if (bossInstance) {
    const boss = bossInstance;
    bossInstance = null;
    try {
      await boss.stop({ timeout: 5000 });
    } catch {
      // ignore
    }
  }
}

function normalizeQueueName(name: string): string {
  // pg-boss only permits alphanumeric, underscores, hyphens, periods, or forward slashes.
  return name.replace(/:/g, '/');
}

export async function sendJob<T = object>(
  queueName: string,
  data: T,
  options?: { priority?: number; startAfter?: number },
): Promise<string | null> {
  const safeQueue = normalizeQueueName(queueName);
  if (bossInstance) {
    return await bossInstance.send(safeQueue, data as object, options);
  }

  // Test mode fallback
  const mockId = `job-mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobEntry = { id: mockId, name: safeQueue, data };
  testJobs.push(jobEntry);

  const worker = testWorkers.get(safeQueue);
  if (worker) {
    // Execute worker asynchronously
    setTimeout(() => {
      void worker(jobEntry);
    }, 0);
  }

  return mockId;
}

export async function registerWorker<T = object>(
  queueName: string,
  handler: (job: { id: string; name: string; data: T }) => Promise<void>,
): Promise<void> {
  const safeQueue = normalizeQueueName(queueName);
  if (bossInstance) {
    await bossInstance.work(safeQueue, async (jobs) => {
      for (const j of jobs) {
        await handler({ id: j.id, name: j.name, data: j.data as T });
      }
    });
    return;
  }

  // Test mode fallback
  testWorkers.set(safeQueue, handler as JobHandler);
}

/** Test helper: get enqueued jobs */
export function getTestEnqueuedJobs(): Array<{ id: string; name: string; data: unknown }> {
  return [...testJobs];
}

export async function getQueueDiagnostics(): Promise<{
  active: boolean;
  status: 'healthy' | 'disabled' | 'degraded';
  activeJobs: number;
  completedJobs: number;
  failedJobs: number;
}> {
  if (!isStarted || !bossInstance) {
    return {
      active: false,
      status: 'disabled',
      activeJobs: testJobs.length,
      completedJobs: 0,
      failedJobs: 0,
    };
  }

  try {
    const db = bossInstance.getDb();
    if (db && typeof db.executeSql === 'function') {
      const result = await db.executeSql(
        `SELECT state, count(*)::int as count FROM pgboss.job GROUP BY state`,
      );
      const rows = (result.rows ?? []) as Array<{ state: string; count: number }>;
      let activeJobs = 0;
      let completedJobs = 0;
      let failedJobs = 0;
      for (const row of rows) {
        if (row.state === 'active' || row.state === 'created' || row.state === 'retry') {
          activeJobs += Number(row.count);
        } else if (row.state === 'completed') {
          completedJobs += Number(row.count);
        } else if (row.state === 'failed' || row.state === 'cancelled') {
          failedJobs += Number(row.count);
        }
      }
      return {
        active: true,
        status: failedJobs > 25 ? 'degraded' : 'healthy',
        activeJobs,
        completedJobs,
        failedJobs,
      };
    }
  } catch {
    // If schema or table does not exist yet
  }

  return {
    active: true,
    status: 'healthy',
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
  };
}
