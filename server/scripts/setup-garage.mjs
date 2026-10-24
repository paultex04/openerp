/**
 * One-shot CLI setup script for Garage S3 object storage.
 *
 * Verifies or provisions the S3 access key, bucket, and permissions via the
 * Garage Admin API (port 3903). Run from the API container terminal:
 *   node server/scripts/setup-garage.mjs
 */
const endpoint = process.env.S3_ENDPOINT || 'http://garage:3900';
const accessKeyId = process.env.S3_ACCESS_KEY_ID || 'GK0123456789abcdef01234567';
const secretAccessKey =
  process.env.S3_SECRET_ACCESS_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const bucketName = process.env.S3_BUCKET || 'openerp-attachments';
const adminToken = process.env.GARAGE_ADMIN_TOKEN || 'openerp-garage-admin-secret-token';

const adminUrl = endpoint.replace(':3900', ':3903');
const headers = {
  Authorization: `Bearer ${adminToken}`,
  'Content-Type': 'application/json',
};

async function main() {
  console.log(`Connecting to Garage Admin API at ${adminUrl}...`);

  // 1. Import Key
  try {
    const importRes = await fetch(`${adminUrl}/v2/ImportKey`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        accessKeyId,
        secretAccessKey,
        name: 'openerp-key',
      }),
    });
    if (importRes.ok) {
      console.log(`✓ S3 access key imported: ${accessKeyId}`);
    } else {
      const err = await importRes.text();
      console.log(`ℹ S3 key notice: ${err}`);
    }
  } catch (err) {
    console.error(`✗ Failed to import S3 key: ${err.message}`);
  }

  // 2. Discover or create bucket
  let bucketId = null;
  try {
    const listRes = await fetch(`${adminUrl}/v2/ListBuckets`, { headers });
    if (listRes.ok) {
      const buckets = await listRes.json();
      const found = buckets.find((b) => b.globalAliases?.includes(bucketName));
      if (found) {
        bucketId = found.id;
        console.log(`✓ Found existing bucket "${bucketName}" (ID: ${bucketId})`);
      }
    }
  } catch (err) {
    console.warn(`Could not list buckets: ${err.message}`);
  }

  if (!bucketId) {
    try {
      const createRes = await fetch(`${adminUrl}/v2/CreateBucket`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ globalAlias: bucketName }),
      });
      if (createRes.ok) {
        const created = await createRes.json();
        bucketId = created.id;
        console.log(`✓ Created new bucket "${bucketName}" (ID: ${bucketId})`);
      } else {
        const err = await createRes.text();
        console.error(`✗ Failed to create bucket "${bucketName}": ${err}`);
      }
    } catch (err) {
      console.error(`✗ Failed to create bucket: ${err.message}`);
    }
  }

  // 3. Allow Key permissions on Bucket
  if (bucketId) {
    try {
      const allowRes = await fetch(`${adminUrl}/v2/AllowBucketKey`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bucketId,
          accessKeyId,
          permissions: {
            read: true,
            write: true,
            owner: true,
          },
        }),
      });
      if (allowRes.ok) {
        console.log(`✓ Permissions granted: read, write, owner for ${accessKeyId}`);
      } else {
        const err = await allowRes.text();
        console.error(`✗ Failed to set permissions: ${err}`);
      }
    } catch (err) {
      console.error(`✗ Failed to grant permissions: ${err.message}`);
    }
  }

  console.log('\nGarage S3 setup sequence complete.');
}

main().catch((err) => {
  console.error('Fatal error during Garage setup:', err);
  process.exit(1);
});
