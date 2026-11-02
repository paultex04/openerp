import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { HttpError } from '../auth/plugin.js';

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig();
  app = await buildApp({ config, logger: false });

  // Add test probe routes for error handling verification
  app.get('/api/_test/throw-domain', async () => {
    throw new HttpError(422, 'CUSTOM_DOMAIN_ERROR', 'Domain validation failed with specifics.');
  });

  app.get('/api/_test/throw-duck-typed', async () => {
    class CustomServiceError extends Error {
      readonly statusCode = 418;
      readonly code = 'I_AM_A_TEAPOT';
      constructor() {
        super('Short and stout.');
      }
    }
    throw new CustomServiceError();
  });

  app.get('/api/_test/throw-prisma-p2003', async () => {
    const error = new Error('Foreign key violation') as Error & {
      code: string;
      meta?: { field_name?: string };
    };
    error.code = 'P2003';
    error.meta = { field_name: 'contracts_clientId_fkey' };
    throw error;
  });

  app.get('/api/_test/throw-prisma-p2025', async () => {
    const error = new Error('Record not found') as Error & { code: string };
    error.code = 'P2025';
    throw error;
  });

  app.get('/api/_test/throw-unhandled-500', async () => {
    throw new Error('Unexpected fatal crash');
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Centralized Universal Error & Diagnostics Handler', () => {
  it('echoes x-request-id and includes requestId in HttpError responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/_test/throw-domain',
      headers: {
        'x-request-id': 'req-test-domain-123',
      },
    });

    expect(res.statusCode).toBe(422);
    expect(res.headers['x-request-id']).toBe('req-test-domain-123');
    const json = res.json();
    expect(json).toEqual({
      error: 'CUSTOM_DOMAIN_ERROR',
      code: 'CUSTOM_DOMAIN_ERROR',
      message: 'Domain validation failed with specifics.',
      requestId: 'req-test-domain-123',
    });
  });

  it('polymorphically normalizes duck-typed domain errors (statusCode + code)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/_test/throw-duck-typed',
    });

    expect(res.statusCode).toBe(418);
    const json = res.json();
    expect(json.error).toBe('I_AM_A_TEAPOT');
    expect(json.code).toBe('I_AM_A_TEAPOT');
    expect(json.message).toBe('Short and stout.');
    expect(typeof json.requestId).toBe('string');
  });

  it('normalizes Prisma P2003 foreign key violations to 409 RECORD_IN_USE', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/_test/throw-prisma-p2003',
    });

    expect(res.statusCode).toBe(409);
    const json = res.json();
    expect(json.error).toBe('FOREIGN_KEY_VIOLATION');
    expect(json.code).toBe('RECORD_IN_USE');
    expect(json.message).toContain('active records depend on it');
    expect(json.field).toBe('contracts_clientId_fkey');
    expect(typeof json.requestId).toBe('string');
  });

  it('normalizes Prisma P2025 missing record errors to 404 RECORD_NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/_test/throw-prisma-p2025',
    });

    expect(res.statusCode).toBe(404);
    const json = res.json();
    expect(json.error).toBe('RECORD_NOT_FOUND');
    expect(json.code).toBe('RECORD_NOT_FOUND');
    expect(typeof json.requestId).toBe('string');
  });

  it('includes requestId and timestamp in unhandled 500 error responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/_test/throw-unhandled-500',
    });

    expect(res.statusCode).toBe(500);
    const json = res.json();
    expect(json.error).toBe('INTERNAL_SERVER_ERROR');
    expect(json.code).toBe('INTERNAL_SERVER_ERROR');
    expect(json.message).toBe('An unexpected error occurred.');
    expect(typeof json.requestId).toBe('string');
    expect(typeof json.timestamp).toBe('string');
    expect(res.headers['x-request-id']).toBe(json.requestId);
  });

  it('includes validation issues and requestId in Zod validation errors', async () => {
    // Calling login with invalid body triggers ZodError
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'not-an-email' },
    });

    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.error).toBe('VALIDATION_FAILED');
    expect(Array.isArray(json.issues)).toBe(true);
    expect(typeof json.requestId).toBe('string');
  });
});
