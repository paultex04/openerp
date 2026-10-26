import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Config } from '../config.js';

let s3Client: S3Client | null = null;
let bucketName = 'openerp-attachments';

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
    s3Client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
    void ensureGarageProvisioned(config);
  } else {
    s3Client = null;
  }
}

export function isS3Active(): boolean {
  return s3Client !== null;
}

export async function uploadBlob(
  key: string,
  data: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  if (!s3Client) {
    throw new Error('S3 client is not configured; cannot upload to object storage');
  }

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: data,
    ContentType: contentType,
  });

  await s3Client.send(command);
  return key;
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
    // Return null if object does not exist (NoSuchKey)
    const err = error as { name?: string };
    if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
      return null;
    }
    throw error;
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
