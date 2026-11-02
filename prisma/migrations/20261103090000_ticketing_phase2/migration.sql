-- Ticketing, phase 2 (SCRUM-1011, epic SCRUM-1007): payment, payout and refund bookkeeping.
-- Still behind `TICKETING` (lib/env.ts), off by default.
--
-- Every CHECK and partial index below exists only here: `db push` creates none.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Organisations: the Razorpay Route linked account an organizer's share is transferred to. KYC is
-- Razorpay's (linked-account onboarding); we keep the id. `enableTicketing` refuses without one.
ALTER TABLE "organisations"
  ADD COLUMN "razorpay_account_id" TEXT,
  ADD CONSTRAINT "organisations_razorpay_account_id_shape" CHECK ("razorpay_account_id" IS NULL OR "razorpay_account_id" ~ '^acc_[A-Za-z0-9]{14}$');

-- Markets: what the buyer quote calls the tax on our fee (contract §8.8). Data, like the rates.
ALTER TABLE "markets"
  ADD COLUMN "ticket_tax_label" TEXT NOT NULL DEFAULT 'Tax',
  ADD CONSTRAINT "markets_ticket_tax_label_length" CHECK (char_length(btrim("ticket_tax_label")) BETWEEN 1 AND 24);
UPDATE "markets" SET "ticket_tax_label" = 'GST' WHERE "code" = 'IN';

-- Orders: the latest checkout attempt failed (Razorpay `payment.failed`), cleared when the pay page
-- starts another (contract §8.2). Only a pending order's is ever read.
ALTER TABLE "ticket_orders" ADD COLUMN "payment_failed_at" TIMESTAMPTZ(6);

-- Orders: a refund is asked for (with its amount and why), then confirmed by Razorpay.
-- `refund_requested_at` is the claim: set once, under the order's row lock, so two refunds of one
-- order cannot both reach Razorpay. A late payment that cannot be seated is asked for here too.
ALTER TABLE "ticket_orders"
  ADD COLUMN "refund_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "refund_requested_minor" INTEGER,
  ADD COLUMN "refund_reason" TEXT,
  ADD COLUMN "refunded_minor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "provider_refund_ref" TEXT,
  ADD COLUMN "refunded_at" TIMESTAMPTZ(6),
  -- Asked for together, and never more than was paid.
  ADD CONSTRAINT "ticket_orders_refund_request_shape" CHECK (
    ("refund_requested_at" IS NULL) = ("refund_requested_minor" IS NULL)
    AND ("refund_requested_minor" IS NULL OR ("refund_requested_minor" BETWEEN 1 AND "total_minor" AND "provider_payment_ref" IS NOT NULL))
    AND ("refund_reason" IS NULL OR char_length("refund_reason") <= 200)
  ),
  ADD CONSTRAINT "ticket_orders_refunded_range" CHECK ("refunded_minor" BETWEEN 0 AND "total_minor"),
  -- Refunded only on Razorpay's word: its refund id, the amount and when.
  ADD CONSTRAINT "ticket_orders_refunded_has_refund" CHECK (
    "status" <> 'refunded' OR ("provider_refund_ref" IS NOT NULL AND "refunded_at" IS NOT NULL AND "refunded_minor" >= 1)
  );
CREATE UNIQUE INDEX "ticket_orders_provider_provider_refund_ref_key" ON "ticket_orders"("provider", "provider_refund_ref");
-- What the reconcile job reads: Razorpay orders never confirmed paid, and refunds asked for and not confirmed.
CREATE INDEX "ticket_orders_unconfirmed_payment" ON "ticket_orders"("hold_expires_at")
  WHERE "provider_payment_ref" IS NULL AND "provider_order_ref" IS NOT NULL;
CREATE INDEX "ticket_orders_unconfirmed_refund" ON "ticket_orders"("refund_requested_at")
  WHERE "refund_requested_at" IS NOT NULL AND "status" <> 'refunded';

-- Payouts: the organizer's share of one paid order, as a Razorpay Route transfer held until three
-- days after the event ends (ticketing-business-model.md, chargebacks). One per order.
--   pending     owed, transfer not made yet (the reconcile job retries)
--   on_hold     transferred, held at Razorpay until `on_hold_until`, then Razorpay releases it
--   reversed    taken back (a refund); `org_debit_minor` is what the org still owes us, e.g. the
--               processing Razorpay keeps when the organizer cancels the event
--   no_account  the organisation had no linked account when the order was paid
CREATE TYPE "ticket_payout_status" AS ENUM ('pending', 'on_hold', 'reversed', 'no_account');

CREATE TABLE "ticket_payouts" (
  "order_id" UUID NOT NULL,
  "org_id" UUID NOT NULL,
  "linked_account_ref" TEXT,
  "amount_minor" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "status" "ticket_payout_status" NOT NULL DEFAULT 'pending',
  "provider_transfer_ref" TEXT,
  "on_hold_until" TIMESTAMPTZ(6) NOT NULL,
  "reversed_minor" INTEGER NOT NULL DEFAULT 0,
  "org_debit_minor" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_payouts_pkey" PRIMARY KEY ("order_id"),
  CONSTRAINT "ticket_payouts_amount_positive" CHECK ("amount_minor" >= 1),
  CONSTRAINT "ticket_payouts_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "ticket_payouts_reversed_range" CHECK ("reversed_minor" BETWEEN 0 AND "amount_minor" AND "org_debit_minor" >= 0),
  -- Money moved only with Razorpay's transfer id; owed only to an account we have.
  CONSTRAINT "ticket_payouts_status_shape" CHECK (
    CASE "status"
      WHEN 'pending' THEN "linked_account_ref" IS NOT NULL AND "provider_transfer_ref" IS NULL
      WHEN 'on_hold' THEN "linked_account_ref" IS NOT NULL AND "provider_transfer_ref" IS NOT NULL
      WHEN 'no_account' THEN "linked_account_ref" IS NULL AND "provider_transfer_ref" IS NULL
      ELSE TRUE
    END
  ),
  CONSTRAINT "ticket_payouts_linked_account_shape" CHECK ("linked_account_ref" IS NULL OR "linked_account_ref" ~ '^acc_[A-Za-z0-9]{14}$')
);
CREATE UNIQUE INDEX "ticket_payouts_provider_transfer_ref_key" ON "ticket_payouts"("provider_transfer_ref");
CREATE INDEX "ticket_payouts_org_id_status_idx" ON "ticket_payouts"("org_id", "status");
-- The reconcile job's retry list.
CREATE INDEX "ticket_payouts_pending" ON "ticket_payouts"("created_at") WHERE "status" = 'pending';

-- Restrict, both: a payout is a money record, like its order.
ALTER TABLE "ticket_payouts" ADD CONSTRAINT "ticket_payouts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "ticket_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ticket_payouts" ADD CONSTRAINT "ticket_payouts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
