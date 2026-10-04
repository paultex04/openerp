-- =============================================================================
-- 0002_vat
--
-- Adds the VAT fields required for SARS-compliant South African invoicing
-- (deferred from Phase 4 into Phase 2 by request).
--
-- Why this is needed: `invoice` previously carried only `total_amount`. There
-- was nowhere to record the VAT-exclusive subtotal, the tax rate, the tax
-- amount, or the VAT-inclusive total, and `client` had no VAT registration
-- number to print on a tax invoice. Phase 4 requires invoice subtotal and tax
-- to reconcile to the cent and demands a compliant ZAR layout, which is
-- impossible without these columns.
--
-- Additive only: new columns with defaults, plus one CHECK constraint. No
-- baseline row is deleted or altered.
--
-- Backfill assumption for the single legacy invoice (INV-2026-03-0042):
-- its VAT treatment is unknown, so it is backfilled as VAT-exempt
-- (tax_rate = 0, tax_amount = 0, total_with_tax = subtotal). This keeps the
-- new CHECK constraint satisfied and is the conservative reading — we do not
-- assert a tax liability we cannot evidence. The record must be reviewed before
-- it is reissued as a tax invoice; see docs/adr-001-baseline-findings.md.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Client: VAT registration
-- ---------------------------------------------------------------------------

ALTER TABLE "client"
    ADD COLUMN "is_vat_registered" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "vat_number"       VARCHAR(50);

COMMENT ON COLUMN "client"."is_vat_registered" IS
  'When false, invoices for this client must not charge VAT (computeVat applies an effective rate of 0).';
COMMENT ON COLUMN "client"."vat_number" IS
  'SARS VAT number, 10 digits. Printed on tax invoices.';

-- ---------------------------------------------------------------------------
-- Amendment: default VAT rate
-- ---------------------------------------------------------------------------

-- The rate is held on the amendment rather than globally so a contract can be
-- taxed differently, and so each invoice can snapshot the rate that applied.
ALTER TABLE "contract_amendment"
    ADD COLUMN "vat_rate" NUMERIC(5,4) NOT NULL DEFAULT 0.1500;

COMMENT ON COLUMN "contract_amendment"."vat_rate" IS
  'Default VAT fraction for invoices under this amendment (0.1500 = 15%). Snapshotted onto each invoice at generation time.';

-- ---------------------------------------------------------------------------
-- Invoice: VAT-exclusive subtotal, rate, tax and VAT-inclusive total
-- ---------------------------------------------------------------------------

ALTER TABLE "invoice"
    ADD COLUMN "subtotal_amount" NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "tax_rate"        NUMERIC(5,4) NOT NULL DEFAULT 0.1500,
    ADD COLUMN "tax_amount"      NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "total_with_tax"  NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN "invoice"."subtotal_amount" IS 'Sum of rounded line subtotals, VAT exclusive.';
COMMENT ON COLUMN "invoice"."tax_rate"        IS 'VAT fraction snapshotted from the amendment at generation time (0.1500 = 15%).';
COMMENT ON COLUMN "invoice"."tax_amount"      IS 'subtotal_amount x effective tax rate, rounded to cents.';
COMMENT ON COLUMN "invoice"."total_with_tax"  IS 'subtotal_amount + tax_amount. The amount payable.';

-- Backfill the legacy invoice as VAT-exempt (see header note).
UPDATE "invoice"
SET "subtotal_amount" = "total_amount",
    "tax_rate"        = 0,
    "tax_amount"      = 0,
    "total_with_tax"  = "total_amount"
WHERE "tax_amount" = 0
  AND "total_with_tax" = 0;

-- ---------------------------------------------------------------------------
-- Integrity constraints
-- ---------------------------------------------------------------------------

-- The core Phase 4 acceptance gate, enforced by the database rather than only
-- by application code: the payable total must always equal subtotal + tax.
ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_total_with_tax_consistent"
    CHECK ("total_with_tax" = "subtotal_amount" + "tax_amount");

ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_amounts_non_negative"
    CHECK ("subtotal_amount" >= 0 AND "tax_amount" >= 0 AND "total_with_tax" >= 0);

-- Guard against a VAT rate outside the plausible legal range.
ALTER TABLE "invoice"
    ADD CONSTRAINT "invoice_tax_rate_range"
    CHECK ("tax_rate" >= 0 AND "tax_rate" <= 1);

ALTER TABLE "contract_amendment"
    ADD CONSTRAINT "contract_amendment_vat_rate_range"
    CHECK ("vat_rate" >= 0 AND "vat_rate" <= 1);