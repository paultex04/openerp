/**
 * Applies each migration under server/prisma/migrations in numeric order, exactly
 * once each, and records what it applied in a small ledger table.
 *
 * ## Why this exists
 *
 * `prisma migrate deploy` cannot be used here: this database's baseline predates
 * Prisma, so there is no `_prisma_migrations` table and deploy fails with P3005
 * (ADR-001). `prisma migrate diff --from-url` must not be used either - against
 * this database it emits a destructive migration.
 *
 * So migrations are hand-written SQL, in the shape Prisma expects, and applied by
 * hand. This script makes "by hand" mean "one command, in order, once each,
 * transactionally" rather than "remember which ones are done", which is the
 * failure mode that produces a schema nobody can reconstruct.
 *
 * ## Why `pg` and not Prisma's client
 *
 * Prisma's extended query protocol uses prepared statements, and Postgres refuses
 * a multi-statement script through one: "cannot insert multiple commands into a
 * prepared statement". A migration file is by nature several statements, and it
 * needs to run inside a real transaction. `pg` speaks the simple protocol and can
 * do both, so this drives it directly.
 *
 * ## Safety properties, in order of how much they matter
 *
 *  1. **It refuses to run twice.** The ledger is the record. Re-running is a no-op.
 *  2. **Each migration is one transaction.** A failure leaves nothing applied,
 *     including a partially-applied statement, because Postgres DDL is
 *     transactional.
 *  3. **A checksum is recorded, and a changed file is reported loudly.** Editing an
 *     applied migration silently is how a schema becomes unexplainable. This does
 *     not block, because the practical case is "fix a comment", but it prints.
 *  4. **Files are applied in numeric prefix order**, so `0010` follows `0009`.
 *  5. **`--baseline` refuses once the ledger has entries.** Past that point the
 *     ledger is the truth and an unrun file must not be able to claim otherwise.
 *
 * Usage:
 *   npm run db:migrate                    apply anything outstanding, building an
 *                                         empty database first if that is what it is
 *   npm run db:migrate -- --dry           list what would apply, and what is recorded
 *   npm run db:migrate -- --init          require an empty database, and build it
 *                                         from server/prisma/schema.sql
 *   npm run db:migrate -- --baseline      record already-present migrations as
 *                                         applied, WITHOUT running them
 *
 * ## `--baseline`, and why it exists
 *
 * This database already carried 0001-0003: they were applied by hand before any
 * ledger existed, which is exactly the "remember which ones are done" failure this
 * script is meant to end. Re-running them would fail on `CREATE TABLE` for tables
 * that already exist.
 *
 * `--baseline` records them with their real checksums and does nothing else. It is
 * a one-time adoption step for an existing database, and it verifies nothing: the
 * printed warning says so, because a tool that let you claim a migration ran
 * without checking would be worse than no tool at all.
 *
 * ## Two kinds of database, and only one of them can run these migrations
 *
 *   1. **A database carrying the baseline** - the original EC&I one. The
 *      migrations extend it, so they run, in order, once each.
 *
 *   2. **A new, empty database.** The migrations cannot run on it at all:
 *      `0001_auth_rbac` creates `app_user` with a foreign key to `employee`, and
 *      no migration creates `employee`, because that table is part of a baseline
 *      predating this repository (ADR-001). The first migration fails with
 *      `relation "employee" does not exist` - which reads like a broken migration
 *      rather than a database that has not been built yet.
 *
 * A new database is built from `server/prisma/schema.sql`: the generated DDL for
 * `schema.prisma`, which is the same diff `prisma db push` applies in CI. The
 * ledger is then *baselined* rather than run, because 0001-0010 are already
 * reflected in that schema. One command does both, transactionally, and refuses to
 * touch a database that already has a schema.
 *
 * `--init` asks for that explicitly. Without it, an empty database with an empty
 * ledger is *taken* to mean a new deployment, which is the only reading available
 * when there is nothing else in it. A database that has the baseline tables is
 * never initialised, whatever the flags say.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnvFile } from '../../scripts/lib/env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// This script lives in server/scripts, and the migrations in server/prisma.
const migrationsDir = resolve(here, '..', 'prisma', 'migrations');
// The generated DDL for a database that does not exist yet. `scripts/schema-sql.mjs`
// owns its contents; see its header for why it is a committed file.
const schemaSqlPath = resolve(here, '..', 'prisma', 'schema.sql');
const dry = process.argv.includes('--dry');
const baseline = process.argv.includes('--baseline');
const init = process.argv.includes('--init');

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

/**
 * The ledger.
 *
 * Deliberately NOT named `_prisma_migrations`: that name belongs to Prisma, and a
 * table here would make `prisma migrate deploy` believe it had a baseline when it
 * does not - turning a loud P3005 into a silent wrong answer.
 */
const LEDGER = 'schema_migration_ledger';

loadEnvFile();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(red('DATABASE_URL is not set. Copy .env.example to .env first.'));
  process.exit(2);
}
const pool = new pg.Pool({ connectionString });

async function ensureLedger() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER} (
      name        text        PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function discover() {
  if (!existsSync(migrationsDir)) {
    throw new Error(`No migrations directory at ${migrationsDir}`);
  }
  return (
    readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Numeric-aware sort, so 0010 follows 0009 rather than preceding it.
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .map((name) => {
        const file = join(migrationsDir, name, 'migration.sql');
        if (!existsSync(file)) throw new Error(`Migration ${name} has no migration.sql`);
        const sql = readFileSync(file, 'utf8');
        return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
      })
  );
}

/**
 * Runs one migration inside a transaction.
 *
 * A single client is checked out so the BEGIN/COMMIT pair is guaranteed to be the
 * same connection - acquiring from the pool between them would silently run the
 * DDL outside the transaction that is supposed to protect it.
 */
async function applyMigration(migration) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await client.query('INSERT INTO schema_migration_ledger (name, checksum) VALUES ($1, $2)', [
      migration.name,
      migration.checksum,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Is there an application schema here at all?
 *
 * `employee` is the right probe: it is a baseline table (ADR-001), so every
 * database this application can use has it, and nothing in this repository
 * creates it. `to_regclass` asks the catalogue directly and returns NULL rather
 * than raising when the table is absent, so this is safe on an empty database.
 */
async function hasApplicationSchema() {
  const { rows } = await pool.query(`SELECT to_regclass('public.employee') IS NOT NULL AS present`);
  return rows[0].present === true;
}

/**
 * Builds a new database from `schema.prisma`, then baselines the ledger.
 *
 * Both halves are one transaction. A schema without the ledger rows would be
 * re-attempted by the next run and fail on `CREATE TABLE "app_user"` for a table
 * that already exists, so applying one without the other is worse than doing
 * nothing: it turns a clear "this is new" into an unclear "this is broken".
 */
async function initialise(migrations) {
  if (!existsSync(schemaSqlPath)) {
    throw new Error(
      `No schema SQL at ${schemaSqlPath}. Regenerate it with \`npm run db:schema:write\`, ` +
        'or build the schema with `npm run db:push` and then record the migrations ' +
        'with `npm run db:migrate -- --baseline`.',
    );
  }

  const sql = readFileSync(schemaSqlPath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    for (const migration of migrations) {
      await client.query('INSERT INTO schema_migration_ledger (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  console.log(dim(`\nOpenERP migrations from ${migrationsDir}\n`));
  await ensureLedger();

  const { rows: applied } = await pool.query(
    `SELECT name, checksum, applied_at FROM ${LEDGER} ORDER BY name`,
  );
  const byName = new Map(applied.map((row) => [row.name, row]));

  const migrations = discover();
  const outstanding = migrations.filter((m) => !byName.has(m.name));

  // ---------------------------------------------------------------------------
  // A database with no application schema. Two opposite situations arrive here,
  // and the ledger is what tells them apart.
  // ---------------------------------------------------------------------------
  if (!(await hasApplicationSchema())) {
    if (applied.length > 0) {
      // No schema, but a ledger that says migrations ran. Something outside this
      // script removed the tables, and guessing which of the two is right would
      // either resurrect a database nobody wants or overwrite one they do.
      console.error(
        red('\nThe ledger records applied migrations, but the database has no schema.\n'),
      );
      console.error(
        dim(
          'Refusing to guess which of the two is correct. Restore the database, or\n' +
            `drop ${LEDGER} to build a new one from schema.sql.\n`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `${yellow('This database is empty.')}\n` +
        dim(
          '  Building it from server/prisma/schema.sql, then recording the\n' +
            '  migrations as already present - that schema already contains them,\n' +
            '  so running them would collide with the tables it creates.\n',
        ),
    );

    if (dry) {
      console.log(`  ${yellow('would init')}  the whole schema from ${dim(schemaSqlPath)}`);
      console.log(`  ${yellow('would record')} ${migrations.length} migration(s) as applied`);
      console.log(
        `\n${yellow('Dry run. Nothing was written.')} ${dim('Re-run without --dry to do it.')}\n`,
      );
      return;
    }

    await initialise(migrations);
    console.log(
      `\n${green(`Initialised from schema.sql; recorded ${migrations.length} migration(s).`)}`,
    );
    console.log(dim('Next: node server/dist/seed.js, or `npm run seed` from a checkout.\n'));
    return;
  }

  if (init) {
    console.error(red('\n--init refused: this database already has an application schema.\n'));
    console.error(
      dim(
        'Initialising is not additive - it would collide with the tables already\n' +
          'there. To converge an existing schema, use `npm run db:push`.\n',
      ),
    );
    process.exitCode = 1;
    return;
  }

  for (const migration of migrations) {
    const record = byName.get(migration.name);
    if (!record) {
      console.log(`  ${dry ? yellow('would apply') : green('applying ')} ${migration.name}`);
      continue;
    }
    if (record.checksum !== migration.checksum) {
      console.log(
        `  ${yellow('CHANGED')} ${migration.name} ${dim(
          `was ${record.checksum.slice(0, 8)}, file is now ${migration.checksum.slice(0, 8)}`,
        )}`,
      );
      console.log(
        `          ${dim(
          'An applied migration was edited. The database did not change; this is reported, not enforced.',
        )}`,
      );
    } else {
      console.log(`  ${dim('applied ')} ${migration.name}`);
    }
  }

  if (outstanding.length === 0) {
    console.log(`\n${green('Schema is up to date.')}\n`);
    return;
  }

  if (baseline) {
    if (applied.length > 0) {
      console.error(
        red(
          '\n--baseline refused: the ledger already has entries, so it is the source of truth.\n',
        ),
      );
      console.error(
        dim('A file that has not run cannot be recorded as having run. Run it instead.\n'),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `\n${yellow('Recording as applied WITHOUT running:')} ${dim(
        'use this only for a database that already carries these migrations',
      )}\n`,
    );
    for (const migration of outstanding) {
      await pool.query('INSERT INTO schema_migration_ledger (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      console.log(`  ${green('recorded ')} ${migration.name}`);
    }
    console.log(
      `\n${green('Baseline recorded.')} ${dim(
        'Verify the schema actually matches before trusting this - the migration was NOT run.',
      )}\n`,
    );
    return;
  }

  if (dry) {
    console.log(
      `\n${yellow(`${outstanding.length} migration(s) outstanding. Re-run without --dry.`)}\n`,
    );
    return;
  }

  for (const migration of outstanding) {
    console.log(`\n  ${dim(`--- ${migration.name} ---`)}`);
    await applyMigration(migration);
    console.log(`  ${green('applied ')} ${migration.name}`);
  }

  console.log(`\n${green(`Applied ${outstanding.length} migration(s).`)}\n`);
}

main()
  .catch((error) => {
    console.error(red(`\nMigration failed: ${error.message}\n`));
    if (error.position !== undefined) {
      console.error(dim(`  at position ${error.position} in the failing statement`));
    }
    // 42P01 is undefined_table. On a new database this is the baseline that
    // predates this repository, and it is the most confusing way for a deployment
    // to fail: it names a table that no file in the repository creates.
    if (error.code === '42P01') {
      console.error(
        dim(
          '  a relation is missing. These migrations extend a baseline that predates\n' +
            '  this repository (ADR-001), so an empty database cannot run them. See the\n' +
            '  top of this file: re-run with --init to build it from schema.sql.',
        ),
      );
    }
    console.error(dim('  the transaction was rolled back - the schema is unchanged\n'));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
