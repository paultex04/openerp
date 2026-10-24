import { describe, expect, it } from 'vitest';
import { initStorage, isS3Active, uploadBlob, downloadBlob, deleteBlob } from './index.js';
import type { Config } from '../config.js';

describe('storage module', () => {
  const minimalConfig = {
    isTest: true,
  } as Config;

  it('reports inactive when S3 credentials are missing', () => {
    initStorage(minimalConfig);
    expect(isS3Active()).toBe(false);
  });

  it('returns null on downloadBlob when S3 is inactive', async () => {
    initStorage(minimalConfig);
    const result = await downloadBlob('avatars/1.webp');
    expect(result).toBeNull();
  });

  it('throws on uploadBlob when S3 is not configured', async () => {
    initStorage(minimalConfig);
    await expect(uploadBlob('key.webp', Buffer.from('test'), 'image/webp')).rejects.toThrow(
      'S3 client is not configured',
    );
  });

  it('safely handles deleteBlob when S3 is not configured', async () => {
    initStorage(minimalConfig);
    await expect(deleteBlob('key.webp')).resolves.not.toThrow();
  });

  it('activates S3 client when endpoint and credentials are provided', () => {
    const s3Config = {
      ...minimalConfig,
      S3_ENDPOINT: 'http://garage:3900',
      S3_REGION: 'garage',
      S3_BUCKET: 'openerp-test',
      S3_ACCESS_KEY_ID: 'GKtest123',
      S3_SECRET_ACCESS_KEY: 'secret123',
      S3_FORCE_PATH_STYLE: true,
    } as Config;

    initStorage(s3Config);
    expect(isS3Active()).toBe(true);

    // Reset back to inactive
    initStorage(minimalConfig);
    expect(isS3Active()).toBe(false);
  });
});
