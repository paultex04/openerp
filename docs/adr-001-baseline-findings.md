# ADR-001: Baseline database findings and pricing reconciliation

Status: **Accepted — requires product owner sign-off on the two open questions below.**

Date: Phase 0 (repo initialisation)

## Context

Phase 0 connected to the existing PostgreSQL instance at `192.168.50.7:5432/openerp-dev`
(PostgreSQL 18.6) and found a **populated** schema rather than an empty database:
18 tables, 8 enum types, and live seed data (22 labour master rates, 6 service codes,
8 labour recipe lines, 3 material BOM lines, 1 contract, 1 amendment, 1 project,
2 jobs, 3 job deliverables, 1 invoice with 3 lines).

Because the mission's Phase 2 acceptance criteria are stated as fixed numeric targets,
the seed data was reconciled against the specification formulas before any engine code
was written.

## Method

For each of the 22 `service_master_rates` rows the specification formulas were applied to
the stored base inputs and the results compared with the stored derived columns
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
OH     = (157.52285 + 7.89) x 7%  =  11.5789
SG&A   = (157.52285 + 7.89 + 11.5789) x 15% = 26.5488
Profit = 207.04955 x 9.5%          =  19.6697
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
3. **No tax/VAT columns anywhere.** `invoice` has only `total_amount`; there is no
   `tax_rate`, `tax_amount`, or `total_with_tax`, and `client` has no tax/VAT registration
   number. Phase 4 requires invoice totals and tax amounts to reconcile to the cent and
   demands a SARS-compliant ZAR layout showing client VAT numbers. This requires a migration.

## Consequences for the build

- The pricing engine must be able to represent **both** policies for `overhead_cost` and
  `sga_cost`: derived-from-parameters and authoritative-stored. A single hard-coded
  derivation cannot simultaneously satisfy F2 and the stated acceptance vector.
- Phase 4 is blocked on a schema migration to add VAT fields.

## Open questions for the product owner

**Q1 — Which is authoritative for overheads and SG&A: the `contract_cost_parameters` rows or
the stored per-rate `overhead_cost` / `sga_cost`?**

- _Option A — parameters are authoritative._ The engine always recomputes. Honest, auditable,
  and future amendments recalculate cleanly. Requires accepting that all 22 stored
  `full_loaded_rate` values change, and that the Phase 2 acceptance target becomes 226.72.
- _Option B — stored values are authoritative (recommended)._ Preserves all historical rates and
  the published 227.61 / 17.5226 vectors exactly. Parameters act as _defaults_ used only when a
  new rate card is built, and per-rate overrides are explicit. Keeps historic contracts stable,
  which matters because `job_service_code.applied_rate` snapshots must remain reproducible.
- _Option C — hybrid._ Recompute only for rate cards created after this release; treat any rate
  card with a stored override as locked. Most faithful to how the business actually operated,
  but the most complex and needs an explicit "locked" flag.

**Q2 — Should the `S00167401` 0.0519 discrepancy be corrected to 27.8639, or preserved as-is?**

Correcting it changes a rate that a job has already been invoiced against under
`INV-2026-03-0042`, so preserving it and logging the discrepancy as a known issue may be safer.
