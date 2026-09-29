-- SCRUM-173: a voided charge keeps when, by whom and why.
ALTER TABLE "placement_charges"
  ADD COLUMN "voided_at" TIMESTAMPTZ(6),
  ADD COLUMN "voided_by" TEXT,
  ADD COLUMN "void_reason" TEXT;

-- Charges voided before this column existed: their last write is the void.
UPDATE "placement_charges" SET "voided_at" = "updated_at" WHERE "status" = 'void' AND "voided_at" IS NULL;
