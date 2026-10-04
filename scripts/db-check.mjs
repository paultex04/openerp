#!/usr/bin/env node
/**
 * Phase 0 connectivity gate.
 *
 * Verifies that we can (1) open a raw TCP socket to the Postgres host and
 * (2) complete a real authenticated connection + query against the database.
 * Exits non-zero on failure so it can gate CI and the phase commit.
 *
 * Usage: node scripts/db-check.mjs
 */
import net from 'node:net';
import { Client } from 'pg';
import { loadEnvFile } from './lib/env.mjs';

loadEnvFile();

const host = process.env.DB_HOST;
const port = Number(process.env.DB_PORT || 5432);
const database = process.env.DB_NAME;
const user = process.env.DB_USER;
const password = process.env.DB_PASSWORD;

const fail = (msg) => {
  console.error(`\x1b[31mFAIL\x1b[0m ${msg}`);
  process.exit(1);
};
const pass = (msg) => console.log(`\x1b[32mPASS\x1b[0m ${msg}`);

for (const [k, v] of Object.entries({ DB_HOST: host, DB_NAME: database, DB_USER: user })) {
  if (!v) fail(`${k} is not set. Copy .env.example to .env and fill it in.`);
}
if (!password) fail('DB_PASSWORD is not set. Copy .env.example to .env and fill it in.');

// ---- 1. Raw TCP reachability --------------------------------------------
await new Promise((resolve, reject) => {
  const socket = net.createConnection({ host, port });
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error(`TCP timeout after 10s to ${host}:${port}`));
  }, 10_000);
  socket.once('connect', () => {
    clearTimeout(timer);
    socket.destroy();
    resolve();
  });
  socket.once('error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
}).then(
  () => pass(`TCP socket reachable at ${host}:${port}`),
  (e) => fail(`TCP unreachable at ${host}:${port} - ${e.message}`),
);

// ---- 2. Authenticated connection + query --------------------------------
const client = new Client({ host, port, user, password, database });
try {
  await client.connect();
  pass(`authenticated as "${user}" against database "${database}"`);

  const { rows } = await client.query('select version()');
  pass(`server version: ${rows[0].version.split(' ').slice(0, 2).join(' ')}`);

  const t = await client.query(
    `select count(*)::int as n from information_schema.tables
      where table_schema = $1 and table_type = 'BASE TABLE'`,
    [process.env.DB_SCHEMA || 'public'],
  );
  pass(`found ${t.rows[0].n} tables in schema "${process.env.DB_SCHEMA || 'public'}"`);

  const e = await client.query(
    `select count(*)::int as n from pg_type t
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = $1 and t.typtype = 'e'`,
    [process.env.DB_SCHEMA || 'public'],
  );
  pass(`found ${e.rows[0].n} enum types in schema "${process.env.DB_SCHEMA || 'public'}"`);

  console.log(`\n\x1b[32mDatabase connectivity verified.\x1b[0m`);
} catch (e) {
  fail(`Postgres query failed - ${e.message}${e.code ? ` (code ${e.code})` : ''}`);
} finally {
  await client.end().catch(() => {});
}
