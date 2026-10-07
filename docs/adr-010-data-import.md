# ADR-010: Bulk data import via a generated spreadsheet template

- **Status:** accepted
- **Date:** 2026-10-07
- **Phase:** 11 (data import)

## Context

Real business data lives outside the system and has to be fed in: clients,
contracts, rate build-ups, service-code recipes, projects, open jobs. Typing
it through the UI is weeks of error-prone work, and raw SQL bypasses every
rule the application enforces (amendment scoping, pricing engines, uniqueness).
The import must therefore accept data in a shape humans can produce and write
it through the same rules the UI obeys.

## Decision

### A generated `.xlsx` template, not a hand-made one

`server/scripts/generate-template.ts` writes
`import/OpenERP-import-template.xlsx`: one sheet per table in dependency
order, dropdown validation for every enum, notes on the tricky columns, and
one worked EXAMPLE row per sheet. Enum lists are imported from
`@openerp/shared` — a new status or category cannot silently diverge from what
the API accepts. The sheet/column spec lives in `server/scripts/import-spec.ts`,
shared by the generator and the importer, so a header renamed in one place
renames it for reading too.

### Dry run by default, `--apply` to write

`server/scripts/import-data.ts` validates everything and writes nothing unless
`--apply` is passed. Validation resolves every reference (file first, then the
live database), checks every enum and format, enforces intra-file and
against-database uniqueness, and runs the shared pricing engines to prove the
rates tie — the dry-run report prints computed rates and job totals. `--apply`
re-runs the same validation and writes only when clean.

### Natural keys in, derived figures out

References are business keys (emails, contract numbers, project codes), never
ids. The sheets carry inputs only: rate build-ups, recipe subtotals, rollups,
planned subtotals and pricing snapshots are computed by `saveRateCard`,
`addDeliverable` and `computeServiceCodeRate` — the same functions the UI
paths call. An imported rate cannot disagree with what the application would
have computed from the same inputs.

### Reuse or refuse, never overwrite

Brokers and contract types resolve to existing rows by exact name. Everything
else aborts on a natural-key collision. Silently updating a VAT flag or a rate
from a spreadsheet would be a data-loss vector; the failure names the row.

### Open work only

Jobs import at Scoping / Scoped / Awaiting PO with planned quantities and zero
actuals. No invoice import, no later statuses, no user accounts (passwords
cannot come from a spreadsheet). History stays where it is; the system takes
over from a clean, reconcilable starting point.

### Sequential writes, backup required

`saveRateCard` and `addDeliverable` own their writes through the shared Prisma
client and cannot join a caller transaction, so the import writes sequentially
after full validation and the operator backs up first. Every write is
audit-logged as `system` by the Prisma extension, row by row.

## Consequences

**Better:** a full hierarchy imports in minutes with a dry-run receipt showing
every computed rate before anything is written. The committed template doubles
as living documentation of the import contract.

**Worse:** the `.xlsx` is a build artifact committed to git (~50 KB). Accepted:
regenerating requires a checkout, and the file reviewers actually open is the
committed one.

**Neutral:** EXAMPLE rows make the template self-demonstrating but mean an
untouched template imports zero rows — which is the safe default.

## Verification

A coherent TEST dataset (client → … → job + crew) dry-ran clean with
hand-verified vectors: rate 203.97 ZAR/hr, activity rollup 203.9700,
R1 rollup 2200.0000, job planned R 2039.70. `--apply` wrote 16 rows across 14
tables; independent reads confirmed all 16 vectors including snapshot
provenance, inheritance (null amendment → project's), default status, and zero
actuals with no invoices created. TEST rows and their audit entries were then
removed; table counts match baseline and no residue remains.
