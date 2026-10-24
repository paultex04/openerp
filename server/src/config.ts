/**
 * Runtime configuration, validated once at boot with Zod.
 *
 * The process refuses to start if a secret is missing or too short, which turns
 * a silent misconfiguration into an immediate, obvious failure.
 */
import { z } from 'zod';

const MIN_SECRET_LENGTH = 32;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  AUTH_JWT_SECRET: z
    .string()
    .min(MIN_SECRET_LENGTH, `AUTH_JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`),
  AUTH_JWT_EXPIRES_IN: z.string().default('15m'),
  AUTH_COOKIE_NAME: z.string().default('openerp_session'),
  AUTH_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  DEFAULT_CURRENCY: z.string().default('ZAR'),
  DEFAULT_VAT_RATE: z.coerce.number().min(0).max(1).default(0.15),

  // S3-compatible Object Storage (e.g. Garage)
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('garage'),
  S3_BUCKET: z.string().default('openerp-attachments'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  isTest: boolean;
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const cfg = parsed.data;

  if (cfg.NODE_ENV === 'production' && !cfg.AUTH_COOKIE_SECURE) {
    throw new Error('AUTH_COOKIE_SECURE must be true when NODE_ENV=production');
  }

  return {
    ...cfg,
    isProduction: cfg.NODE_ENV === 'production',
    isTest: cfg.NODE_ENV === 'test',
  };
}
