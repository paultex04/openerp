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
      // Swallowed error to prevent crashing on connection drops
      void err;
    });

    await boss.start();
    bossInstance = boss;
    isStarted = true;
  } catch {
    // If pg-boss fails to connect on boot, remain graceful
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

export async function sendJob<T = object>(
  queueName: string,
  data: T,
  options?: { priority?: number; startAfter?: number },
): Promise<string | null> {
  if (bossInstance) {
    return await bossInstance.send(queueName, data as object, options);
  }

  // Test mode fallback
  const mockId = `job-mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const jobEntry = { id: mockId, name: queueName, data };
  testJobs.push(jobEntry);

  const worker = testWorkers.get(queueName);
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
  if (bossInstance) {
    await bossInstance.work(queueName, async (jobs) => {
      for (const j of jobs) {
        await handler({ id: j.id, name: j.name, data: j.data as T });
      }
    });
    return;
  }

  // Test mode fallback
  testWorkers.set(queueName, handler as JobHandler);
}

/** Test helper: get enqueued jobs */
export function getTestEnqueuedJobs(): Array<{ id: string; name: string; data: unknown }> {
  return [...testJobs];
}
