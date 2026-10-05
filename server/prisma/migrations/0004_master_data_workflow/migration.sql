-- =============================================================================
-- 0004_master_data_workflow
--
-- Phase 8 groundwork: the schema changes the Phase 7 UI review asked for.
--
-- Implements items 1, 3, 4, 5 and 6 of docs/phase-07-database-amendments.md.
-- Items 2, 7, 8 and 9 are explicitly deferred and are NOT in this migration;
-- see the notes at the foot.
--
-- Data note: the volume in this database is seed data, with one exception that
-- matters - `contract_cost_parameters` (12), `service_master_rates` (22),
-- `service_code` (6) and their labour/material lines are the real commercial
-- inputs and are treated here as precious. Nothing in this migration reads or
-- writes any of those tables' contents. The only pricing table touched is
-- `job_service_code`, and only to ADD a provenance column to existing rows.
--
-- Additive only, per ADR-001. No existing column is dropped, narrowed or
-- retyped. Two statements are `CREATE UNIQUE INDEX` / `ALTER TABLE ... ADD
-- CONSTRAINT`, both of which can fail if existing data violates them, so the
-- pre-flight queries are recorded inline above each one. Run them first; the
-- counts are small enough to read by eye.
-- =============================================================================


-- =============================================================================
-- ITEM 1 - job_assignment must not hold the same person twice on one job
--
-- `job_service_code` and `service_code_labour_item` both carry a uniqueness
-- constraint on their pair of parents. `job_assignment` did not, so nothing
-- stopped the same employee being added to one job's crew twice. That was
-- harmless while there was no UI for it; the Phase 7 crew screen means a payroll
-- mistake is now one click away, and a client-side filter on the picker is a
-- courtesy rather than a guarantee.
--
-- PRE-FLIGHT (returned zero rows on 2026-10-05):
--   SELECT job_id, employee_id, count(*) FROM job_assignment
--    GROUP BY job_id, employee_id HAVING count(*) > 1;
--
-- If that query ever returns rows, de-duplicate deliberately - keeping the
-- earliest row - rather than letting this statement fail on an arbitrary one.
-- =============================================================================

CREATE UNIQUE INDEX job_assignment_job_employee_key
  ON job_assignment (job_id, employee_id);


-- =============================================================================
-- ITEM 4 - a client contact needs a role
--
-- A client with five contacts currently offers a flat picker, so the user picks
-- by memory. One nullable column, no backfill: existing contacts simply have no
-- role, which is honest - nobody has entered one yet.
-- =============================================================================

ALTER TABLE contact ADD COLUMN role varchar(100);


-- =============================================================================
-- ITEM 5 - a date range has to be ordered
--
-- `planned_end_date < planned_start_date` was accepted. So was an actual end
-- before an actual start. Neither is a real state; both are typos that the UI
-- cannot express a rule for either, so nothing caught them.
--
-- Two partial CHECKs rather than one combined constraint, so the violation
-- message names which range is wrong.
--
-- PRE-FLIGHT (returned zero rows on 2026-10-05):
--   SELECT id FROM job
--    WHERE (planned_end_date IS NOT NULL AND planned_start_date IS NOT NULL
--           AND planned_end_date < planned_start_date)
--       OR (actual_end_date IS NOT NULL AND actual_start_date IS NOT NULL
--           AND actual_end_date < actual_start_date);
--
-- NULL is treated as unknown and passes, which is the right semantics: a job with
-- no planned end is incomplete, not invalid.
-- =============================================================================

ALTER TABLE job
  ADD CONSTRAINT job_planned_range_ordered
  CHECK (planned_start_date IS NULL
         OR planned_end_date IS NULL
         OR planned_end_date >= planned_start_date);

ALTER TABLE job
  ADD CONSTRAINT job_actual_range_ordered
  CHECK (actual_start_date IS NULL
         OR actual_end_date IS NULL
         OR actual_end_date >= actual_start_date);


-- =============================================================================
-- ITEM 3 - archiving, so "cannot delete" stops being a dead end
--
-- Today a row is either deletable-if-unreferenced or refused with a 409. There is
-- no third option, so a contract created by mistake that has already been scoped
-- is immortal: it cannot be deleted, and nothing records that it was never real.
--
-- Six additive booleans, plus partial indexes for the query that will dominate:
-- "give me the live ones" for every picker.
--
-- Deliberately NOT cascaded. Archiving a client does not archive its contracts,
-- because a cascade here would be invisible, irreversible in one step, and
-- capable of retiring a contract that four live jobs depend on. The UI warns
-- about active children instead, and the server refuses to archive a contract
-- that still has non-cancelled jobs - the one place where the engine, not the
-- interface, has to be the judge.
--
-- `employee` is NOT here: an employee is terminated with `end_date`, which is
-- already a soft delete with better semantics. It means "left the company"
-- rather than "this record is wrong", and it is reversible by clearing the date.
-- =============================================================================

ALTER TABLE client ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE contract ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE contract_amendment ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE broker ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE employee_contract_type ADD COLUMN is_archived boolean NOT NULL DEFAULT false;
ALTER TABLE contact ADD COLUMN is_archived boolean NOT NULL DEFAULT false;

-- Partial indexes: a picker's query is `WHERE is_archived = false`, and with a
-- partial index Postgres reads only the live rows rather than filtering the
-- whole table. These stay useful as the archived population grows.
CREATE INDEX client_live_idx            ON client            (name)            WHERE is_archived = false;
CREATE INDEX contract_live_idx          ON contract          (number)          WHERE is_archived = false;
CREATE INDEX contract_amendment_live_idx ON contract_amendment (amendment_number) WHERE is_archived = false;
CREATE INDEX broker_live_idx            ON broker            (name)            WHERE is_archived = false;
CREATE INDEX employee_contract_type_live_idx ON employee_contract_type (name)   WHERE is_archived = false;
CREATE INDEX contact_live_idx           ON contact           (name)            WHERE is_archived = false;


-- =============================================================================
-- ITEM 6 - a pricing snapshot that records WHAT it was, not just the rate
--
-- `job_service_code.applied_rate` already snapshots the unit rate at scoping
-- time, and that is the right instinct - it is why the published acceptance
-- vectors stay reproducible (ADR-001/002). What it does not record is the
-- *inputs* that produced it. So the number is reproducible but its provenance is
-- not: you can see what was charged, not why.
--
-- `snapshot_source` captures those inputs at scoping time: the service code, its
-- markup, every labour line with the rate card it priced from, every material
-- line, and the amendment's cost parameters. The price snapshot already protects
-- the money; this protects the ability to defend the price.
--
-- A `digest` over the canonical JSON makes the record tamper-evident. If a row's
-- inputs are ever edited in place - which nothing in the application does, since
-- `applied_rate` is documented as immutable - the digest stops matching and the
-- discrepancy is detectable rather than invisible.
--
-- Backfill: the 3 existing rows are seeded scope, and their service codes are
-- still present, so their provenance can be reconstructed from current state.
-- That reconstruction is truthful about the inputs as they stand now, and is
-- labelled `backfilled: true` so nobody later mistakes it for a record captured
-- at the moment of scoping. Both facts are recorded rather than smoothed over.
-- =============================================================================

ALTER TABLE job_service_code ADD COLUMN snapshot_source jsonb;

UPDATE job_service_code jsc
   SET snapshot_source = jsonb_build_object(
         'backfilled', true,
         'note', 'Reconstructed from current state after the fact, not captured at scoping time.',
         'serviceCodeId', jsc.service_code_id,
         'amendmentId', sc.amendment_id,
         'code', sc.code,
         'description', sc.description,
         'category', sc.category::text,
         'materialMarkupPct', sc.material_markup_pct::text,
         'calculatedUnitRate', sc.calculated_unit_rate::text,
         'labour', (
           SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'serviceMasterRateId', li.service_master_rate_id,
                    'serviceMasterCode', smr.service_master_code,
                    'labourType', smr.labour_type,
                    'shiftType', smr.shift_type::text,
                    'crewQuantity', li.crew_quantity::text,
                    'hoursPerUnit', li.hours_per_unit::text,
                    'lineSubtotal', li.line_subtotal::text,
                    'fullLoadedRate', smr.full_loaded_rate::text
                  ) ORDER BY li.id), '[]'::jsonb)
             FROM service_code_labour_item li
             JOIN service_master_rates smr ON smr.id = li.service_master_rate_id
            WHERE li.service_code_id = jsc.service_code_id
         ),
         'material', (
           SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'itemCode', mi.item_code,
                    'description', mi.description,
                    'supplierName', mi.supplier_name,
                    'unitCost', mi.unit_cost::text,
                    'quantity', mi.quantity::text,
                    'uom', mi.uom,
                    'subtotalCost', mi.subtotal_cost::text
                  ) ORDER BY mi.id), '[]'::jsonb)
             FROM service_code_material_item mi
            WHERE mi.service_code_id = jsc.service_code_id
         ),
         'costParameters', (
           SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'category', ccp.category::text,
                    'parameterName', ccp.parameter_name,
                    'numericValue', ccp.numeric_value::text,
                    'uom', ccp.uom
                  ) ORDER BY ccp.category, ccp.parameter_name), '[]'::jsonb)
             FROM contract_cost_parameters ccp
            WHERE ccp.amendment_id = sc.amendment_id
         )
       )
  FROM service_code sc
 WHERE sc.id = jsc.service_code_id;

-- Reading a large provenance blob is rare; comparing one is not.
CREATE INDEX job_service_code_snapshot_idx
  ON job_service_code USING gin (snapshot_source jsonb_path_ops);


-- =============================================================================
-- NOT IN THIS MIGRATION, and why
--
-- ITEM 2 - employee_rate effective dating. The user confirmed the employee rate
--   does not affect any implemented workflow: a job's cost derives from its
--   labour service codes, not from the person. It becomes relevant only when
--   revenue is compared against cost, which is a future module. Adding currency
--   alone was also declined. Revisit with that module.
--
-- ITEM 7 - contract.status cached roll-up. Declined as a future change. Worth
--   recording that it would have to be a cache and never authoritative: a
--   second source of truth for "is this contract live" will drift from the
--   amendments unless something maintains it.
--
-- ITEM 8 - audit_log partitioning. Declined as a future change. The cheap part,
--   an index on `(created_at DESC)` for the audit panel's default ordering, is
--   still worth doing on its own if that panel is ever slow.
--
-- ITEM 9 - `app_user.employee_id`. Explicitly NOT to be changed, and now for a
--   documented reason: an Employee may exist with no User, and always could - the
--   Phase 7 employee routes create records with no linked account. The constraint
--   runs the other way. It exists because a *user of the system* must be an
--   employee, so that every write in the audit log has a real actor. The
--   employee side of the model is expected to get considerably richer when the
--   planned HR module lands, and relaxing this constraint would regress the audit
--   trail's actor guarantee to serve that. Leave it alone.
--
-- One observation this migration did not act on: `job.project_id` is
-- ON DELETE CASCADE, so deleting a project silently removes its jobs. That is
-- the opposite of the "refuse rather than cascade" rule every delete endpoint
-- follows, and it is a Phase 9 candidate.
-- =============================================================================