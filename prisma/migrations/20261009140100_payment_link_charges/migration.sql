-- Sponsor payment links (step 17; SCRUM-560): the purchase row a Razorpay
-- Payment Link is held to. `payment_link.paid` settles the charge it names,
-- with the amount and the organisation read from this row, never from the
-- delivery's notes.
--
-- Additive. Rolling back is a NEW forward migration dropping the index, the
-- constraints and the column (never SQL by hand against staging or
-- production). Export `billing_checkouts` first if a link has been paid: it is
-- a tax record. A rollback of the CODE alone is safe: older code reads no
-- `charge_id` and records a `payment_link.paid` without applying it.

-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction (measured, step 17 review), so this file is its own: SET LOCAL
-- holds only inside it, and a failure part-way leaves nothing half-applied.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- RESTRICT: a charge with a payment behind it is never deleted (voided, kept).
ALTER TABLE "billing_checkouts" ADD COLUMN "charge_id" UUID;
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_charge_id_fkey"
  FOREIGN KEY ("charge_id") REFERENCES "placement_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "billing_checkouts_charge_id_idx" ON "billing_checkouts"("charge_id");

-- The link the sponsor pays at (Razorpay's short URL). Not a secret: Razorpay
-- emails it to them, and their Placements page shows it.
ALTER TABLE "billing_checkouts" ADD COLUMN "pay_url" TEXT;

-- A payment link names its charge, and nothing else does.
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_charge_shape" CHECK (
  ("kind" = 'payment_link') = ("charge_id" IS NOT NULL)
);

-- One link a charge could still be paid through, or was paid through. A
-- second "Send payment link" returns the open one (lib/charge-actions.ts);
-- this holds if two requests race past that. `expired` and `cancelled` are
-- closed: a new link may follow one. Statuses are Razorpay's.
CREATE UNIQUE INDEX "billing_checkouts_one_link_per_charge" ON "billing_checkouts" ("charge_id")
  WHERE "charge_id" IS NOT NULL AND "status" IN ('created', 'issued', 'partially_paid', 'paid');

COMMIT;
