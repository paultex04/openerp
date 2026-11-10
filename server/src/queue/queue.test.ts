import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  initJobQueue,
  stopJobQueue,
  sendJob,
  registerWorker,
  isQueueActive,
  getTestEnqueuedJobs,
} from './index.js';
import type { Config } from '../config.js';

describe('background job queue', () => {
  const testConfig = {
    isTest: true,
  } as Config;

  beforeEach(async () => {
    await initJobQueue(testConfig);
  });

  afterEach(async () => {
    await stopJobQueue();
  });

  it('initializes in test mode with active status', () => {
    expect(isQueueActive()).toBe(true);
  });

  it('enqueues a job and records it in test mode', async () => {
    const jobId = await sendJob('export/invoices', { format: 'csv', year: 2026 });
    expect(jobId).toMatch(/^job-mock-/);

    const jobs = getTestEnqueuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.name).toBe('export/invoices');
    expect(jobs[0]?.data).toEqual({ format: 'csv', year: 2026 });
  });

  it('dispatches enqueued jobs to registered worker in test mode', async () => {
    let handledJob: unknown = null;

    await registerWorker('export/timesheets', async (job) => {
      handledJob = job.data;
    });

    await sendJob('export/timesheets', { employeeId: 42 });

    // Wait for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handledJob).toEqual({ employeeId: 42 });
  });

  it('normalizes legacy colon queue names to compliant forward slash names', async () => {
    const jobId = await sendJob('legacy:queue:name', { foo: 'bar' });
    expect(jobId).toMatch(/^job-mock-/);

    const jobs = getTestEnqueuedJobs();
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob?.name).toBe('legacy/queue/name');
  });

  it('does not retain jobs in memory when inactive outside test mode', async () => {
    await stopJobQueue();
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const result = await sendJob('export/invoices', { huge: 'payload' });
      expect(result).toBeNull();
      expect(getTestEnqueuedJobs()).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
