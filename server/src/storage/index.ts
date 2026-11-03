import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import dns from 'node:dns/promises';
import type { Config } from '../config.js';

let s3Client: S3Client | null = null;
let currentConfig: Config | null = null;
let bucketName = 'openerp-attachments';

export class StorageError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

function createS3ClientInstance(endpoint: string, config: Config): S3Client {
  return new S3Client({
    endpoint,
    region: config.S3_REGION,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  });
}

export async function resolveS3Endpoint(endpoint: string): Promise<string> {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    // Check if the current host resolves
    try {
      await dns.lookup(host);
      return endpoint;
    } catch {
      // Host resolution failed. Try common candidate hostnames on Docker networks
      const candidates = [
        'garage',
        'openerp-garage',
        'openerp-garage-1',
        'openerp_garage_1',
        'garage-1',
        's3',
        'minio',
      ];
      for (const candidate of candidates) {
        if (candidate === host) continue;
        try {
          await dns.lookup(candidate);
          url.hostname = candidate;
          console.log(
            `[storage] Auto-resolved S3 storage host from '${host}' to '${candidate}' (${url.toString()})`,
          );
          return url.toString();
        } catch {
          // keep searching
        }
      }
    }
  } catch {
    // Malformed URL, return original
  }
  return endpoint;
}

export async function ensureGarageProvisioned(config: Config): Promise<void> {
  if (config.isTest) return;
  if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) return;
  if (!config.S3_ENDPOINT.includes('garage') && !config.S3_ENDPOINT.includes(':3900')) return;

  try {
    const adminUrl = config.S3_ENDPOINT.replace(':3900', ':3903');
    const adminToken = process.env.GARAGE_ADMIN_TOKEN || 'openerp-garage-admin-secret-token';
    const headers = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };

    // 1. Check or Import Key (idempotent)
    try {
      const keyInfoRes = await fetch(
        `${adminUrl}/v2/GetKeyInfo?id=${encodeURIComponent(config.S3_ACCESS_KEY_ID)}`,
        { headers },
      );
      if (!keyInfoRes.ok) {
        await fetch(`${adminUrl}/v2/ImportKey`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            name: 'openerp-key',
          }),
        });
      }
    } catch {
      // Ignore if key cannot be queried/imported or already exists
    }

    // 2. Discover or create bucket
    let bucketId: string | null = null;
    try {
      const listRes = await fetch(`${adminUrl}/v2/ListBuckets`, { headers });
      if (listRes.ok) {
        const buckets = (await listRes.json()) as Array<{ id: string; globalAliases?: string[] }>;
        const found = buckets.find((b) => b.globalAliases?.includes(config.S3_BUCKET));
        if (found) {
          bucketId = found.id;
        }
      }
    } catch {
      // ignore
    }

    if (!bucketId) {
      try {
        const createRes = await fetch(`${adminUrl}/v2/CreateBucket`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            globalAlias: config.S3_BUCKET,
          }),
        });
        if (createRes.ok) {
          const created = (await createRes.json()) as { id: string };
          bucketId = created.id;
        }
      } catch {
        // ignore
      }
    }

    // 3. Grant key access permissions on the bucket
    if (bucketId) {
      try {
        await fetch(`${adminUrl}/v2/AllowBucketKey`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            bucketId,
            accessKeyId: config.S3_ACCESS_KEY_ID,
            permissions: {
              read: true,
              write: true,
              owner: true,
            },
          }),
        });
      } catch {
        // ignore
      }
    }
  } catch {
    // Best-effort auto-provisioning
  }
}

export function initStorage(config: Config): void {
  if (config.S3_ENDPOINT && config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY) {
    bucketName = config.S3_BUCKET;
    currentConfig = config;
    s3Client = createS3ClientInstance(config.S3_ENDPOINT, config);

    // Asynchronously verify host resolution and provision Garage
    void (async () => {
      try {
        const resolved = await resolveS3Endpoint(config.S3_ENDPOINT!);
        if (resolved !== config.S3_ENDPOINT) {
          s3Client = createS3ClientInstance(resolved, config);
          process.env.S3_ENDPOINT = resolved;
        }
        await ensureGarageProvisioned({ ...config, S3_ENDPOINT: resolved });
      } catch {
        // Best-effort
      }
    })();
  } else {
    s3Client = null;
    currentConfig = null;
  }
}

export function isS3Active(): boolean {
  return s3Client !== null;
}

export async function getStorageDiagnostics(): Promise<{
  active: boolean;
  reachable: boolean;
  bucket: string;
  endpoint: string | null;
  latencyMs: number | null;
  error?: string;
}> {
  if (!s3Client || !isS3Active()) {
    return {
      active: false,
      reachable: false,
      bucket: bucketName,
      endpoint: null,
      latencyMs: null,
    };
  }

  const start = performance.now();
  try {
    const command = new HeadBucketCommand({ Bucket: bucketName });
    await s3Client.send(command);
    return {
      active: true,
      reachable: true,
      bucket: bucketName,
      endpoint: process.env.S3_ENDPOINT ?? null,
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    return {
      active: true,
      reachable: false,
      bucket: bucketName,
      endpoint: process.env.S3_ENDPOINT ?? null,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uploadBlob(
  key: string,
  data: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  if (!s3Client) {
    throw new StorageError(
      503,
      'STORAGE_UNAVAILABLE',
      'S3 client is not configured; cannot upload to object storage.',
    );
  }

  try {
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: data,
      ContentType: contentType,
    });

    await s3Client.send(command);
    return key;
  } catch (err: any) {
    // If ENOTFOUND, try to resolve candidate hostnames and retry once
    if (err?.code === 'ENOTFOUND' || err?.message?.includes('ENOTFOUND')) {
      if (currentConfig?.S3_ENDPOINT) {
        try {
          const resolved = await resolveS3Endpoint(currentConfig.S3_ENDPOINT);
          if (resolved !== currentConfig.S3_ENDPOINT) {
            s3Client = createS3ClientInstance(resolved, currentConfig);
            process.env.S3_ENDPOINT = resolved;
            const retryCommand = new PutObjectCommand({
              Bucket: bucketName,
              Key: key,
              Body: data,
              ContentType: contentType,
            });
            await s3Client.send(retryCommand);
            return key;
          }
        } catch {
          // fall through to throw original error
        }
      }
    }
    throw new StorageError(
      502,
      'STORAGE_UPLOAD_FAILED',
      `Failed to upload to object storage: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function downloadBlob(
  key: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!s3Client) {
    return null;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const response = await s3Client.send(command);
    if (!response.Body) return null;

    const byteArray = await response.Body.transformToByteArray();
    return {
      buffer: Buffer.from(byteArray),
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  } catch (error: unknown) {
    // Return null if object does not exist or network unavailable
    const err = error as { name?: string; code?: string; message?: string };
    if (
      err.name === 'NoSuchKey' ||
      err.name === 'NotFound' ||
      err.code === 'ENOTFOUND' ||
      err.message?.includes('ENOTFOUND')
    ) {
      return null;
    }
    throw error;
  }
}

export async function listBlobs(
  prefix: string,
): Promise<Array<{ key: string; sizeBytes: number; lastModified: Date }>> {
  if (!s3Client) return [];
  try {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    });
    const res = await s3Client.send(command);
    return (res.Contents ?? [])
      .filter((c) => Boolean(c.Key))
      .map((c) => ({
        key: c.Key!,
        sizeBytes: c.Size ?? 0,
        lastModified: c.LastModified ?? new Date(),
      }));
  } catch {
    return [];
  }
}

export async function deleteBlob(key: string): Promise<void> {
  if (!s3Client) return;

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });
    await s3Client.send(command);
  } catch {
    // Best-effort cleanup
  }
}
