# ADR-002: Pricing engine policies, percentage units and VAT

Status: **Accepted.**

Date: Phase 2 (commercial pricing engine)

## Context

Phase 1 adopted an existing, populated database (see [ADR-001](adr-001-baseline-findings.md)).
Phase 2 builds the pricing engine on top of it and must satisfy two fixed acceptance vectors:

- Artisan Electrical (`S00250451`) at **227.61 ZAR/hr**
- Cable removal (`S00247970`) at **17.5226 ZAR/m**

Three decisions were needed that ADR-001 had flagged as open, plus two defects surfaced only once
the engine ran against real data.

## Decisions

### D1 — Two overhead policies, authoritative by default

`overhead_cost` and `sga_cost` are authoritative stored inputs. The amendment's
`contract_cost_parameters` seed them **only when a rate card is first created**.

```
authoritative (default)   overheadCost / sgaCost supplied by the caller
derived                   overhead = (BDL + equipment) x overheadPct
                          sga     = (BDL + equipment + overhead) x sgaPct
```

`profit_cost` and `full_loaded_rate` are always derived. An ordinary edit preserves the stored
figures; re-deriving requires an explicit `deriveOverheads: true`.

**Why:** re-deriving moves Artisan Electrical from 227.61 to 226.72 (ADR-001 F2). Making it
opt-in keeps historic contracts and invoiced `applied_rate` snapshots reproducible while leaving
the divergence visible rather than hidden.

The engine exposes `compareAgainstDerived` so the UI can show _both_ figures and the delta. The
comparison baseline is always the **stored** card, never the request payload — an early
implementation compared the derived figures against themselves and always reported a delta of
zero, which the HTTP smoke test caught.

### D2 — Recomputation never silently overwrites a stored rate

`computeServiceCode` returns the recomputed rate plus a variance against
`calculated_unit_rate`. Writing requires an explicit `POST /api/service-codes/:id/apply-rate`
(or `?applyRate=true`).

**Why:** ADR-001 Q2 requires service code `S00167401` to keep its historical 27.9158 even though
a recomputation yields 27.8639, because invoice `INV-2026-03-0042` already billed at the stored
rate. The recipe builder surfaces the variance as a warning with an explicit accept button.

### D3 — Rate equality uses a 4dp epsilon, not half a cent

`compareWithStored` treats two rates as equal within **0.00005 ZAR** — a twentieth of a cent.
Well below the 4dp precision unit rates carry, well above the ~1e-15 noise of binary floating
point.

**Why:** the original half-cent threshold was appropriate for money but wrong for unit rates. It
would silently classify a genuine 0.0001 ZAR difference as "no change", which matters because a
service code's rate feeds invoicing.

### D4 — Rounding is half-away-from-zero via a string round-trip

`round()` shifts the decimal point through `Number(\`${n}e${dp}\`)`rather than`n * 10 ** dp`.

**Why:** `1.005 * 100` is `100.49999999999999`, so the naive form rounds 1.005 **down** to 1.00
where finance expects 1.01. The string round-trip yields the correctly-rounded double `100.5`.
The naive `Math.round` is also half-up, so it rounds `-2.5` to `-2`; rounding the magnitude and
reapplying the sign gives half-away-from-zero.

## Defects found and fixed

### E1 — Percentage units are inconsistent in the baseline (high severity)

The baseline stores percentages in two different units:

```
contract_cost_parameters.numeric_value  'Fair Profit Margin %'  =  9.500000  (percent)
contract_cost_parameters.numeric_value  'R1 Material Markup %'  = 10.000000  (percent)
service_master_rates.wage_premium_pct                         =  0.0050    (fraction)
service_code.material_markup_pct                              =  0.1000    (fraction)
```

Reading a `numeric_value` percentage as a fraction inflates the full loaded rate roughly
**tenfold**: Artisan Electrical computed as **2182.56 ZAR/hr** instead of 227.61. Caught by the
Phase 2 integration suite.

Fixed by `PERCENT_NUMBER_KEYS` in `shared/src/pricing/tier1.ts`, which divides percent-valued
parameters by 100 on read. `GET /api/amendments/:id/cost-parameters` returns both the raw rows
(exactly as stored) and a normalised `engine` projection, so no caller has to guess.

### E2 — Prisma enum type names needed `@@map`

The baseline created enum **types** as `job_status_enum`, `shift_type_enum`, etc., while the
**variants** carry labels like `'00. Cancelled'`. Mapping variants alone is not enough: without an
enum-level `@@map`, Prisma emits casts to `::"ShiftType"`, which does not exist, and every
filtered query fails with `type "public.ShiftType" does not exist`.

All eight enums now carry both a per-variant `@map` and an enum-level `@@map("<name>_enum")`.
The label/key boundary is centralised in `shared/src/schemas/prisma-enums.ts`; routes never cast
by hand. **The API returns labels, Prisma speaks keys** — the HTTP smoke test caught an early
version leaking `R1_MATERIAL` to clients, now a regression assertion.

### E3 — A single-cent legacy divergence on `S00258036`

The stored full loaded rate is 122.49 where the build-up yields 122.50, because the original
spreadsheet truncated the final sum instead of rounding it. Preserved, and now asserted as a
documented expectation rather than left as a latent surprise.

## Consequence: an intentionally safe database boundary

`prisma migrate diff` against the live database reports differences, and they are all cosmetic:
Prisma wants its own index and constraint naming conventions. **No destructive operation appears
in the diff** — no dropped tables, no dropped enum types, no recreated foreign keys on data-bearing
columns.

This is a direct result of the Phase 0 lesson: `prisma migrate diff --from-url` against a database
whose schema was not created by Prisma produces a destructive, wrong migration. Migrations here
remain hand-written and additive-only.

## Test isolation

Integration tests run against the configured database but are strictly additive: they create only
`employee`, `app_user` and (for the amendment-mismatch guard) a throwaway amendment plus rate card,
all deleted in `afterAll` or a `finally` block. Baseline commercial rows are read but never
modified. `scripts/smoke-phase2.mjs` additionally exercises the running API over HTTP, covering the
cookie security attributes, the 401 paths, and both acceptance vectors.
