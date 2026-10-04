# ADR-001: Baseline database findings and pricing reconciliation

Status: **Accepted.** Q1 resolved as Option B, Q2 resolved as "preserve and log".

Date: Phase 0 (repo initialisation), ratified at Phase 1

## Context

Phase 0 connected to the existing PostgreSQL instance at `192.168.50.7:5432/openerp-dev`
(PostgreSQL 18.6) and found a **populated** schema rather than an empty database: 18 tables,
8 enum types, and live seed data (22 labour master rates, 6 service codes, 8 labour recipe
lines, 3 material BOM lines, 1 contract, 1 amendment, 1 project, 2 jobs, 3 job deliverables,
1 invoice with 3 lines).

Because the mission's Phase 2 acceptance criteria are stated as fixed numeric targets, the seed
data was reconciled against the specification formulas before any engine code was written.

## Method

For each of the 22 `service_master_rates` rows the specification formulas were applied to the
stored base inputs and the results compared with the stored derived columns
(`overhead_cost`, `sga_cost`, `profit_cost`, `full_loaded_rate`). The same was done for the
8 `service_code_labour_item` rows and the 6 `service_code` rollups.

## Findings

### F1 — Tier 1 full-loaded-rate and profit formulas are confirmed correct

Using the **stored** `overhead_cost` and `sga_cost` as inputs:

- `profit_cost = (BDL + Equipment + OH + SG&A + PPE + Transport) x Profit %` reproduces the
  stored `profit_cost` for **22 of 22** rows.
- `full_loaded_rate = BDL + Equipment + PPE + Transport + OH + SG&A + Profit` reproduces the
  stored `full_loaded_rate` for **13 of 22** rows exactly, and for the remaining 9 rows to
  **within 0.01 ZAR** (single-cent rounding accumulated in the seed data).

The reference vector reconciles: Artisan Electrical (`S00250451`) yields **227.61 ZAR/hr**.

### F2 — BLOCKER: stored overheads imply ~8.2%, not the 7% parameter

`overhead_cost / (Base Direct Labour + Equipment)` is **not** 7%. Observed values:

| Service master code | Labour type          | Implied overhead |
| ------------------- | -------------------- | ---------------- |
| `S00250451`         | Artisan Electrical   | 8.222%           |
| `S00143130`         | Artisan Installation | 8.185%           |
| `S00248135`         | Artisan Instrument   | 8.179%           |
| `S00248122`         | Boilermaker Class 1  | 8.360%           |
| `S00248154`         | Boilermaker Class 2  | 8.318%           |
| `S00248157`         | Boilermaker Class 3  | 8.279%           |

Meanwhile `contract_cost_parameters` row 9 (`amendment_id = 1`) states
`Operational Overhead % = 7.000000`.

Recomputing Artisan Electrical strictly from the parameters yields:

```
BDL    = 113.13285 + 15.46 + 28.93 = 157.52285
OH     = (157.52285 + 7.89) x 7%          =  11.5789
SG&A   = (157.52285 + 7.89 + 11.5789) x 15% = 26.5488
Profit = 207.04955 x 9.5%                  =  19.6697
FLR    = 226.72
```

That is **226.72, not the required 227.61** — a 0.89 ZAR/hr (0.39%) shortfall. The stated
acceptance vector of 227.61 is reachable **only if `overhead_cost` and `sga_cost` are treated
as authoritative stored inputs rather than being recomputed from `contract_cost_parameters`.**

### F3 — Tier 2 activity pricing is confirmed correct

`S00247970` ("Remove, Cable (All Cores) Electrical & Instrumentation; 1.5mm - 16mm", UOM `M`)
reconciles to the required **17.5226 ZAR/m** exactly, across all four crew roles:

| Role                  | Crew | Hours/unit | Loaded rate | Line subtotal |
| --------------------- | ---- | ---------- | ----------- | ------------- |
| Artisan Electrical    | 1.00 | 0.0100     | 227.61      | 2.2761        |
| Labourer              | 1.00 | 0.0100     | 88.39       | 0.8839        |
| Electrical Supervisor | 1.00 | 0.0200     | 397.18      | 7.9436        |
| Safety Officer        | 1.00 | 0.0200     | 320.95      | 6.4190        |
| **Total**             |      |            |             | **17.5226**   |

R1 material pricing also confirmed: `(18500 + 1704 + 1416) x 1.10 = 23 782.00 ZAR`, matching
`R1-CABLE-SUPPLY-01`.

### F4 — Data defects in the seed data

1. **`S00167401` rate inflated by 0.0519 ZAR.** Labour line `id = 8` (Safety Officer) stores
   `line_subtotal = 9.6804`, but `1.00 x 0.0300 x 320.95 = 9.6285`. The service code rollup
   (27.9158) equals the sum of the _stored_ subtotals, so the rollup inherits the error.
   A spec-faithful recomputation yields 27.8639.
2. **Three service codes have no recipes.** `S00247971`, `S00172384` and `S00167371` carry
   non-zero `calculated_unit_rate` (17.5226 / 17.5226 / 27.9158) but have **zero**
   `service_code_labour_item` rows. These are placeholder rows awaiting their BOMs.
3. **No tax/VAT columns anywhere.** `invoice` has only `total_amount`; there is no `tax_rate`,
   `tax_amount`, or `total_with_tax`, and `client` has no tax/VAT registration number. Phase 4
   requires invoice totals and tax amounts to reconcile to the cent and demands a SARS-compliant
   ZAR layout showing client VAT numbers. This requires a migration.

## Consequences for the build

- The pricing engine must represent **both** treatments of `overhead_cost` and `sga_cost`:
  derived-from-parameters when a rate card is first created, and authoritative-stored
  thereafter. A single hard-coded derivation cannot simultaneously satisfy F2 and the stated
  acceptance vector.
- Phase 4 is blocked on a schema migration to add VAT fields.

## Decisions

### Q1 — Stored per-rate overheads and SG&A are authoritative (Option B)

`service_master_rates.overhead_cost` and `.sga_cost` are treated as **authoritative stored
inputs**, not values to be recomputed.

- The engine seeds `overhead_cost` / `sga_cost` from `contract_cost_parameters` only when a
  **new** rate card is built.
- Once written, a rate card's derived columns are not recomputed from parameters, so the
  published 227.61 ZAR/hr and 17.5226 ZAR/m vectors hold, and historic contracts plus the
  invoiced `job_service_code.applied_rate` snapshots remain reproducible.
- `profit_cost` and `full_loaded_rate` _are_ derived, from the authoritative inputs — verified
  correct for all 22 rows (F1).

### Q2 — The `S00167401` discrepancy is preserved, not corrected

The 0.0519 ZAR inflation on service code `S00167401` (F4.1) is left in place and recorded as a
known data defect. Invoice `INV-2026-03-0042` has already been issued at that rate, so
"correcting" the master would break reconciliation with billing that has left the business.

**Operational consequence:** the engine must be able to recompute a service code and report the
variance against the stored `calculated_unit_rate` rather than silently overwriting it. Phase 2
surfaces this as a warning on the recipe builder, not a hard failure.

### Q3 — No identity migration was needed (correction to Phase 0)

Phase 0 initially concluded that the baseline tables lacked `id` defaults, because a probe of
`pg_attrdef` returned nothing and `information_schema.sequences` listed zero sequences.
**That conclusion was wrong.** The tables do use `GENERATED ALWAYS AS IDENTITY`; identity
sequences are registered in `pg_sequence` rather than as standalone relations, so neither probe
saw them. Verified against `pg_attribute.attidentity = 'a'` for all 18 tables.

Migration `0001_auth_rbac` therefore contains **no** primary-key changes. Worth recording
regardless: the initial hand-written draft attempted the ALTER and Postgres correctly rejected
it with _column id of relation broker is already an identity column_ before anything was applied.

### Q4 — A blanket global rate limit was rejected

`@fastify/rate-limit` is registered with `global: false`. A per-client ceiling of N requests per
minute across the whole API would eventually cap legitimate bulk reads (a 2 000-row job list is
a single request) with no security benefit. Limits are applied per route where brute force is a
real concern — currently credential endpoints only (10 logins/minute), and skipped under
`NODE_ENV=test` because the suite performs far more logins than a human would.

## Test isolation note

The baseline schema predates the test harness and there is no fixture loader or dedicated test
database. Integration tests therefore run against the configured database but are strictly
additive: they create only `employee` and `app_user` rows (with random UUID emails) and delete
them in `afterAll`. They never touch baseline commercial or operational data.

Before CI is introduced, a `0000_baseline` migration and a dedicated `openerp-test` database
should be added. The baseline DDL cannot currently be regenerated from scratch because
`pg_dump` is not installed on the workstation; it exists only as the live database.

## Open questions carried forward

- **Phase 4 blocker:** `invoice` has no `tax_rate`, `tax_amount` or `total_with_tax`, and
  `client` has no VAT registration number. A migration is required before SARS-compliant ZAR
  invoicing can be built. Not yet scheduled.
