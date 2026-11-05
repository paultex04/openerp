/**
 * Automated Database Backup Service (Zero-Downtime, pg_dump & S3 Integration).
 *
 * Responsibilities:
 *  - Performs non-blocking, consistent binary or SQL backups using `pg_dump`.
 *  - If `pg_dump` is absent from PATH, falls back gracefully to a transactional SQL export.
 *  - Streams and stores compressed backups in Garage S3 (`backups/`) with 14-day automatic retention.
 *  - Supports on-demand administrative backups from the UI diagnostics panel.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import { dbPool } from '../db/client.js';
import { uploadBlob, downloadBlob, listBlobs, deleteBlob, isS3Active } from '../storage/index.js';

const execFileAsync = promisify(execFile);

export interface BackupRecord {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  storage: 's3' | 'local' | 'both';
  method: 'pg_dump' | 'sql_fallback';
  key?: string;
}

const LOCAL_BACKUP_DIR = resolve(process.cwd(), 'data/backups');

function ensureLocalBackupDir(): void {
  try {
    if (!existsSync(LOCAL_BACKUP_DIR)) {
      mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
    }
  } catch {
    // best-effort
  }
}

function getDbCredentials(): {
  host: string;
  port: string;
  user: string;
  pass: string;
  db: string;
} {
  let host = process.env.PGHOST || process.env.DB_HOST || 'db';
  let port = process.env.PGPORT || process.env.DB_PORT || '5432';
  let user = process.env.PGUSER || process.env.POSTGRES_USER || 'openerp';
  let pass = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || 'openerp';
  let db = process.env.PGDATABASE || process.env.POSTGRES_DB || 'openerp';

  if (process.env.DATABASE_URL) {
    try {
      const parsed = new URL(process.env.DATABASE_URL);
      host = parsed.hostname || host;
      port = parsed.port || port;
      user = parsed.username ? decodeURIComponent(parsed.username) : user;
      pass = parsed.password ? decodeURIComponent(parsed.password) : pass;
      db = parsed.pathname ? parsed.pathname.replace(/^\//, '') : db;
    } catch {
      // fallback
    }
  }

  return { host, port, user, pass, db };
}

/**
 * ChartDB PostgreSQL Smart Query.
 * Extracts comprehensive relational schema metadata (tables, columns, types, indexes, FKs, constraints)
 * into a single JSON payload that ChartDB can ingest directly to render an ER diagram.
 */
const CHARTDB_METADATA_QUERY = `/* PostgreSQL edition */
WITH fk_info AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', replace(schema_name, '"', ''), '"',
',"table":"', replace(table_name::text, '"', ''), '"',
',"column":"', replace(fk_column::text, '"', ''), '"',
',"foreign_key_name":"', foreign_key_name, '"',
',"reference_schema":"', COALESCE(replace(reference_schema, '"', ''), 'public'), '"',
',"reference_table":"', replace(reference_table, '"', ''), '"',
',"reference_column":"', replace(reference_column, '"', ''), '"',
',"fk_def":"', replace(fk_def, '"', ''),
'"}')), ',') as fk_metadata
FROM (
SELECT c.conname AS foreign_key_name,
n.nspname AS schema_name,
CASE
WHEN position('.' in conrelid::regclass::text) > 0
THEN split_part(conrelid::regclass::text, '.', 2)
ELSE conrelid::regclass::text
END AS table_name,
a.attname AS fk_column,
nr.nspname AS reference_schema,
CASE
WHEN position('.' in confrelid::regclass::text) > 0
THEN split_part(confrelid::regclass::text, '.', 2)
ELSE confrelid::regclass::text
END AS reference_table,
af.attname AS reference_column,
pg_get_constraintdef(c.oid) as fk_def
FROM
pg_constraint AS c
JOIN
pg_attribute AS a ON a.attnum = ANY(c.conkey) AND a.attrelid = c.conrelid
JOIN
pg_class AS cl ON cl.oid = c.conrelid
JOIN
pg_namespace AS n ON n.oid = cl.relnamespace
JOIN
pg_attribute AS af ON af.attnum = ANY(c.confkey) AND af.attrelid = c.confrelid
JOIN
pg_class AS clf ON clf.oid = c.confrelid
JOIN
pg_namespace AS nr ON nr.oid = clf.relnamespace
WHERE
c.contype = 'f'
AND connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog')
) AS x
), pk_info AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', replace(schema_name, '"', ''), '"',
',"table":"', replace(pk_table, '"', ''), '"',
',"column":"', replace(pk_column, '"', ''), '"',
',"pk_def":"', replace(pk_def, '"', ''),
'"}')), ',') AS pk_metadata
FROM (
SELECT connamespace::regnamespace::text AS schema_name,
CASE
WHEN strpos(conrelid::regclass::text, '.') > 0
THEN split_part(conrelid::regclass::text, '.', 2)
ELSE conrelid::regclass::text
END AS pk_table,
unnest(string_to_array(substring(pg_get_constraintdef(oid) FROM '\\((.*?)\\)'), ',')) AS pk_column,
pg_get_constraintdef(oid) as pk_def
FROM
pg_constraint
WHERE
contype = 'p'
AND connamespace::regnamespace::text NOT IN ('information_schema', 'pg_catalog')
) AS y
),
indexes_cols AS (
SELECT  tnsp.nspname                                                                AS schema_name,
trel.relname                                                                    AS table_name,
pg_relation_size('"' || tnsp.nspname || '".' || '"' || irel.relname || '"') AS index_size,
irel.relname                                                                AS index_name,
am.amname                                                                   AS index_type,
a.attname                                                                   AS col_name,
(CASE WHEN i.indisunique = TRUE THEN 'true' ELSE 'false' END)               AS is_unique,
irel.reltuples                                                              AS cardinality,
1 + Array_position(i.indkey, a.attnum)                                      AS column_position,
CASE o.OPTION & 1 WHEN 1 THEN 'DESC' ELSE 'ASC' END                         AS direction
FROM pg_index AS i
JOIN pg_class AS trel ON trel.oid = i.indrelid
JOIN pg_namespace AS tnsp ON trel.relnamespace = tnsp.oid
JOIN pg_class AS irel ON irel.oid = i.indexrelid
JOIN pg_am AS am ON irel.relam = am.oid
CROSS JOIN LATERAL unnest (i.indkey)
WITH ORDINALITY AS c (colnum, ordinality) LEFT JOIN LATERAL unnest (i.indoption)
WITH ORDINALITY AS o (option, ordinality)
ON c.ordinality = o.ordinality JOIN pg_attribute AS a ON trel.oid = a.attrelid AND a.attnum = c.colnum
WHERE tnsp.nspname NOT LIKE 'pg_%'
GROUP BY tnsp.nspname, trel.relname, irel.relname, am.amname, i.indisunique, i.indexrelid, irel.reltuples, a.attname, Array_position(i.indkey, a.attnum), o.OPTION, i.indpred
),
cols AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', cols.table_schema,
'","table":"', cols.table_name,
'","name":"', cols.column_name,
'","ordinal_position":', cols.ordinal_position,
',"type":"', CASE WHEN cols.column_default IS NOT NULL AND cols.column_default LIKE 'nextval(%' THEN
CASE
WHEN LOWER(replace(cols.data_type, '"', '')) = 'smallint' THEN 'smallserial'
WHEN LOWER(replace(cols.data_type, '"', '')) = 'integer' THEN 'serial'
WHEN LOWER(replace(cols.data_type, '"', '')) = 'bigint' THEN 'bigserial'
ELSE LOWER(replace(cols.data_type, '"', ''))
END
WHEN cols.data_type = 'ARRAY' THEN
format_type(pg_type.typelem, NULL)
WHEN LOWER(replace(cols.data_type, '"', '')) = 'user-defined' THEN
format_type(pg_type.oid, NULL)
ELSE
LOWER(replace(cols.data_type, '"', ''))
END,
'","character_maximum_length":"', COALESCE(cols.character_maximum_length::text, 'null'),
'","precision":',
CASE
WHEN cols.data_type = 'numeric' OR cols.data_type = 'decimal'
THEN CONCAT('{"precision":', COALESCE(cols.numeric_precision::text, 'null'),
',"scale":', COALESCE(cols.numeric_scale::text, 'null'), '}')
ELSE 'null'
END,
',"nullable":', CASE WHEN (cols.IS_NULLABLE = 'YES') THEN 'true' ELSE 'false' END,
',"default":"', CASE WHEN cols.column_default IS NOT NULL AND cols.column_default LIKE 'nextval(%' THEN '' ELSE COALESCE(replace(replace(cols.column_default, '"', '\\"'), '\\x', '\\\\x'), '') END,
'","collation":"', COALESCE(cols.COLLATION_NAME, ''),
'","comment":"', null,
'","is_identity":', CASE
WHEN cols.is_identity = 'YES' THEN 'true'
WHEN cols.column_default IS NOT NULL AND cols.column_default LIKE 'nextval(%' THEN 'true'
ELSE 'false'
END,
',"is_array":', CASE
WHEN cols.data_type = 'ARRAY' OR pg_type.typelem > 0 THEN 'true'
ELSE 'false'
END,
'}')), ',') AS cols_metadata
FROM information_schema.columns cols
LEFT JOIN pg_catalog.pg_class c
ON c.relname = cols.table_name
JOIN pg_catalog.pg_namespace n
ON n.oid = c.relnamespace AND n.nspname = cols.table_schema
LEFT JOIN pg_catalog.pg_description dsc
ON dsc.objoid = c.oid AND dsc.objsubid = cols.ordinal_position
LEFT JOIN pg_catalog.pg_attribute attr
ON attr.attrelid = c.oid AND attr.attname = cols.column_name
LEFT JOIN pg_catalog.pg_type
ON pg_type.oid = attr.atttypid
LEFT JOIN pg_catalog.pg_type AS elem_type
ON elem_type.oid = pg_type.typelem
WHERE cols.table_schema NOT IN ('information_schema', 'pg_catalog')
), indexes_metadata AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', schema_name,
'","table":"', table_name,
'","name":"', index_name,
'","column":"', replace(col_name :: TEXT, '"', E'"'),
'","index_type":"', index_type,
'","cardinality":', cardinality,
',"size":', index_size,
',"unique":', is_unique,
',"column_position":', column_position,
',"direction":"', LOWER(direction),
'"}')), ',') AS indexes_metadata
FROM indexes_cols x 
), tbls AS (
SELECT array_to_string(array_agg(CONCAT('{',
'"schema":"', tbls.TABLE_SCHEMA, '",',
'"table":"', tbls.TABLE_NAME, '",',
'"rows":', COALESCE((SELECT s.n_live_tup
FROM pg_stat_user_tables s
WHERE tbls.TABLE_SCHEMA = s.schemaname AND tbls.TABLE_NAME = s.relname),
0), ', "type":"', tbls.TABLE_TYPE, '",', '"engine":"",', '"collation":"",',
'"comment":"', null,
'"}'
)),
',') AS tbls_metadata
FROM information_schema.tables tbls
LEFT JOIN pg_catalog.pg_class c ON c.relname = tbls.TABLE_NAME
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
AND n.nspname = tbls.TABLE_SCHEMA
LEFT JOIN pg_catalog.pg_description dsc ON dsc.objoid = c.oid
AND dsc.objsubid = 0
WHERE tbls.TABLE_SCHEMA NOT IN ('information_schema', 'pg_catalog') 
), config AS (
SELECT array_to_string(
array_agg(CONCAT('{"name":"', conf.name, '","value":"', replace(conf.setting, '"', E'"'), '"}')),
',') AS config_metadata
FROM pg_settings conf
), views AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', views.schemaname,
'","view_name":"', viewname,
'","view_definition":""}')),
',') AS views_metadata
FROM pg_views views
WHERE views.schemaname NOT IN ('information_schema', 'pg_catalog') 
), custom_types AS (
SELECT array_to_string(array_agg(type_json), ',') AS custom_types_metadata
FROM (
-- ENUM types
SELECT CONCAT(
'{"schema":"', n.nspname,
'","type":"', t.typname,
'","kind":"enum"',
',"values":[', string_agg('"' || e.enumlabel || '"', ',' ORDER BY e.enumsortorder), ']}'
) AS type_json
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') 
GROUP BY n.nspname, t.typname

UNION ALL

-- COMPOSITE types
SELECT CONCAT(
'{"schema":"', schema_name,
'","type":"', type_name,
'","kind":"composite"',
',"fields":[', fields_json, ']}'
) AS type_json
FROM (
SELECT
n.nspname AS schema_name,
t.typname AS type_name,
string_agg(
CONCAT('{"field":"', a.attname, '","type":"', format_type(a.atttypid, a.atttypmod), '"}'),
',' ORDER BY a.attnum
) AS fields_json
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN pg_class c ON c.oid = t.typrelid
JOIN pg_attribute a ON a.attrelid = c.oid
WHERE t.typtype = 'c'
AND c.relkind = 'c'  -- Only user-defined composite types
AND a.attnum > 0 AND NOT a.attisdropped
AND n.nspname NOT IN ('pg_catalog', 'information_schema') 
GROUP BY n.nspname, t.typname
) AS comp
) AS all_types
), check_constraints AS (
SELECT array_to_string(array_agg(CONCAT('{"schema":"', replace(schema_name, '"', ''), '"',
',"table":"', replace(table_name, '"', ''), '"',
',"expression":"', replace(replace(check_expr, '"', '\\"'), E'\\n', ' '),
'"}')), ',') AS check_constraints_metadata
FROM (
SELECT
n.nspname AS schema_name,
CASE
WHEN position('.' in c.conrelid::regclass::text) > 0
THEN split_part(c.conrelid::regclass::text, '.', 2)
ELSE c.conrelid::regclass::text
END AS table_name,
substring(pg_get_constraintdef(c.oid) FROM 'CHECK \\((.*)\\)') AS check_expr
FROM pg_constraint c
JOIN pg_class cl ON cl.oid = c.conrelid
JOIN pg_namespace n ON n.oid = cl.relnamespace
WHERE c.contype = 'c'
AND n.nspname NOT IN ('information_schema', 'pg_catalog')
) AS chk
)
SELECT CONCAT('{    "fk_info": [', COALESCE(fk_metadata, ''),
'], "pk_info": [', COALESCE(pk_metadata, ''),
'], "columns": [', COALESCE(cols_metadata, ''),
'], "indexes": [', COALESCE(indexes_metadata, ''),
'], "tables":[', COALESCE(tbls_metadata, ''),
'], "views":[', COALESCE(views_metadata, ''),
'], "check_constraints": [', COALESCE(check_constraints_metadata, ''),
'], "custom_types": [', COALESCE(custom_types_metadata, ''),
'], "database_name": "', CURRENT_DATABASE(), '", "version": "', '',
'"}') AS metadata_json_to_import
FROM fk_info, pk_info, cols, indexes_metadata, tbls, config, views, check_constraints, custom_types;
`;

/**
 * Generates a clean database schema dump.
 * Supports:
 *   - 'sql': standard PostgreSQL DDL statements via pg_dump (or schema.sql fallback)
 *   - 'json': ChartDB-compatible Smart Query metadata extraction
 */
export async function generateSchemaDumpBuffer(
  format: 'sql' | 'json' = 'sql',
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    try {
      const result = await dbPool.query<{ metadata_json_to_import: string }>(
        CHARTDB_METADATA_QUERY,
      );
      const jsonStr = result.rows[0]?.metadata_json_to_import || '{}';
      return {
        buffer: Buffer.from(jsonStr, 'utf8'),
        filename: `openerp-schema-${dateStr}.json`,
        contentType: 'application/json; charset=utf-8',
      };
    } catch (err) {
      console.warn(
        '[backup] ChartDB JSON introspection query failed, falling back to SQL dump:',
        err,
      );
    }
  }

  const { host, port, user, pass, db } = getDbCredentials();

  try {
    const { stdout } = await execFileAsync(
      'pg_dump',
      [
        '-h',
        host,
        '-p',
        port,
        '-U',
        user,
        '-d',
        db,
        '--schema-only',
        '--no-owner',
        '--no-privileges',
      ],
      {
        env: { ...process.env, PGPASSWORD: pass },
        encoding: 'buffer',
        maxBuffer: 60 * 1024 * 1024, // 60 MB buffer
      },
    );
    return {
      buffer: stdout as unknown as Buffer,
      filename: `openerp-schema-${dateStr}.sql`,
      contentType: 'application/sql; charset=utf-8',
    };
  } catch (dumpErr: unknown) {
    console.warn('[backup] pg_dump --schema-only failed, falling back to schema.sql:', dumpErr);
    const schemaSqlPath = resolve(process.cwd(), 'server/prisma/schema.sql');
    const altPath = resolve(process.cwd(), 'prisma/schema.sql');
    const target = existsSync(schemaSqlPath) ? schemaSqlPath : altPath;
    if (existsSync(target)) {
      return {
        buffer: readFileSync(target),
        filename: `openerp-schema-${dateStr}.sql`,
        contentType: 'application/sql; charset=utf-8',
      };
    }
    throw new Error('Failed to generate schema dump: pg_dump failed and schema.sql not found.', {
      cause: dumpErr,
    });
  }
}

/**
 * Executes a PostgreSQL database dump.
 * First tries `pg_dump`; if not available, executes a pure-SQL table dump.
 */
async function generateDumpBuffer(): Promise<{
  buffer: Buffer;
  method: 'pg_dump' | 'sql_fallback';
}> {
  const { host, port, user, pass, db } = getDbCredentials();

  try {
    const { stdout } = await execFileAsync(
      'pg_dump',
      ['-h', host, '-p', port, '-U', user, '-d', db, '--no-owner', '--no-privileges', '-F', 'c'],
      {
        env: { ...process.env, PGPASSWORD: pass },
        encoding: 'buffer',
        maxBuffer: 120 * 1024 * 1024, // 120 MB buffer
      },
    );
    return { buffer: stdout as unknown as Buffer, method: 'pg_dump' };
  } catch (dumpErr: unknown) {
    // If pg_dump command is not found or fails, generate a clean SQL dump via dbPool
    console.warn(
      '[backup] pg_dump failed or not in PATH, falling back to SQL table export:',
      dumpErr,
    );
    const sqlBuf = await generateSqlExportBuffer();
    return { buffer: sqlBuf, method: 'sql_fallback' };
  }
}

/**
 * Pure-SQL fallback table exporter (zero external binaries required).
 */
async function generateSqlExportBuffer(): Promise<Buffer> {
  const client = await dbPool.connect();
  try {
    const lines: string[] = [
      `-- OpenERP Database Backup (Fallback Export)`,
      `-- Generated at: ${new Date().toISOString()}`,
      `BEGIN;`,
    ];

    const tablesRes = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    for (const { table_name } of tablesRes.rows) {
      const rowsRes = await client.query(`SELECT * FROM "${table_name}"`);
      if (rowsRes.rows.length === 0) continue;

      lines.push(`\n-- Table: ${table_name}`);
      for (const row of rowsRes.rows) {
        const columns = Object.keys(row)
          .map((k) => `"${k}"`)
          .join(', ');
        const values = Object.values(row)
          .map((v) => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number' || typeof v === 'boolean') return String(v);
            if (v instanceof Date) return `'${v.toISOString()}'`;
            if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
            return `'${String(v).replace(/'/g, "''")}'`;
          })
          .join(', ');
        lines.push(
          `INSERT INTO "${table_name}" (${columns}) VALUES (${values}) ON CONFLICT DO NOTHING;`,
        );
      }
    }

    lines.push(`COMMIT;`);
    return Buffer.from(lines.join('\n'), 'utf8');
  } finally {
    client.release();
  }
}

/**
 * Generates and uploads a complete database backup with automatic retention pruning.
 */
export async function createDatabaseBackup(): Promise<BackupRecord> {
  const { buffer: dumpBuffer, method } = await generateDumpBuffer();
  const ext = method === 'pg_dump' ? 'dump' : 'sql';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `openerp-backup-${timestamp}.${ext}`;
  const sizeBytes = dumpBuffer.length;
  let storage: 's3' | 'local' | 'both' = 'local';
  let s3Key: string | undefined;

  // 1. Upload to Garage S3 if active
  if (isS3Active()) {
    s3Key = `backups/${filename}`;
    try {
      await uploadBlob(
        s3Key,
        dumpBuffer,
        method === 'pg_dump' ? 'application/octet-stream' : 'application/sql',
      );
      storage = 's3';
      // Prune backups older than 14 days in S3
      void pruneS3Backups(14);
    } catch (s3Err) {
      console.warn('[backup] Could not upload backup to S3, saving locally:', s3Err);
    }
  }

  // 2. Also save to local disk if directory exists or storage is local
  ensureLocalBackupDir();
  try {
    const localPath = resolve(LOCAL_BACKUP_DIR, filename);
    writeFileSync(localPath, dumpBuffer);
    storage = storage === 's3' ? 'both' : 'local';
    pruneLocalBackups(14);
  } catch (localErr) {
    console.warn('[backup] Could not save local backup copy:', localErr);
  }

  return {
    id: filename,
    filename,
    sizeBytes,
    createdAt: new Date().toISOString(),
    storage,
    method,
    key: s3Key,
  };
}

/**
 * Returns a list of all existing database backups across S3 and local storage.
 */
export async function listDatabaseBackups(): Promise<BackupRecord[]> {
  const map = new Map<string, BackupRecord>();

  // 1. Fetch S3 backups
  if (isS3Active()) {
    try {
      const blobs = await listBlobs('backups/');
      for (const blob of blobs) {
        const fname = basename(blob.key);
        if (!fname.endsWith('.dump') && !fname.endsWith('.sql')) continue;
        map.set(fname, {
          id: fname,
          filename: fname,
          sizeBytes: blob.sizeBytes,
          createdAt: blob.lastModified.toISOString(),
          storage: 's3',
          method: fname.endsWith('.dump') ? 'pg_dump' : 'sql_fallback',
          key: blob.key,
        });
      }
    } catch {
      // ignore
    }
  }

  // 2. Read local backups
  ensureLocalBackupDir();
  try {
    if (existsSync(LOCAL_BACKUP_DIR)) {
      const files = readdirSync(LOCAL_BACKUP_DIR);
      for (const file of files) {
        if (!file.endsWith('.dump') && !file.endsWith('.sql')) continue;
        const filePath = resolve(LOCAL_BACKUP_DIR, file);
        const stats = statSync(filePath);
        const existing = map.get(file);
        if (existing) {
          existing.storage = 'both';
        } else {
          map.set(file, {
            id: file,
            filename: file,
            sizeBytes: stats.size,
            createdAt: stats.mtime.toISOString(),
            storage: 'local',
            method: file.endsWith('.dump') ? 'pg_dump' : 'sql_fallback',
          });
        }
      }
    }
  } catch {
    // ignore
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/**
 * Fetches the binary buffer for a specific backup file.
 */
export async function getBackupBuffer(filename: string): Promise<Buffer | null> {
  const safeFilename = basename(filename);

  // 1. Check S3
  if (isS3Active()) {
    try {
      const obj = await downloadBlob(`backups/${safeFilename}`);
      if (obj?.buffer) return obj.buffer;
    } catch {
      // fall back to local
    }
  }

  // 2. Check Local
  const localPath = resolve(LOCAL_BACKUP_DIR, safeFilename);
  if (existsSync(localPath)) {
    return readFileSync(localPath);
  }

  return null;
}

/**
 * Prunes backups older than `maxDays` from S3.
 */
async function pruneS3Backups(maxDays: number): Promise<void> {
  if (!isS3Active()) return;
  try {
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const blobs = await listBlobs('backups/');
    for (const blob of blobs) {
      if (blob.lastModified.getTime() < cutoff) {
        console.log(`[backup] Pruning expired S3 backup: ${blob.key}`);
        await deleteBlob(blob.key);
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Prunes backups older than `maxDays` from local storage.
 */
function pruneLocalBackups(maxDays: number): void {
  try {
    if (!existsSync(LOCAL_BACKUP_DIR)) return;
    const cutoff = Date.now() - maxDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(LOCAL_BACKUP_DIR);
    for (const file of files) {
      const p = resolve(LOCAL_BACKUP_DIR, file);
      const st = statSync(p);
      if (st.mtimeMs < cutoff) {
        console.log(`[backup] Pruning expired local backup: ${file}`);
        unlinkSync(p);
      }
    }
  } catch {
    // best-effort
  }
}
