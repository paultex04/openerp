/**
 * Global test setup.
 *
 * Loads `.env` and forces NODE_ENV=test so the app starts quietly and the
 * cookie `secure` flag is disabled for the plain-HTTP test server.
 *
 * Database note: the baseline schema predates this test harness and has no
 * fixture loader, so integration tests run against the configured database and
 * clean up every row they create (see `createTestUser`). They only ever touch
 * `employee` and `app_user`, plus temporary `role_permission` edits that each
 * test restores in a `finally`, never baseline commercial or operational data.
 *
 * Note `loadEnvFile()` reads the workspace `.env`, so these tests share the dev
 * database: a `finally` that restores the wrong grant set leaks into real data.
 */
import { loadEnvFile } from '../lib/env.js';

loadEnvFile();
process.env.NODE_ENV = 'test';

// Deterministic secret for reproducible tokens during tests.
process.env.AUTH_JWT_SECRET ??=
  'test-only-secret-0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
