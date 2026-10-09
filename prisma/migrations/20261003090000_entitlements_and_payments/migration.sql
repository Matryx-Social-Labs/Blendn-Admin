-- Money (step 16, plan v2 §9 and §9.1b): entitlements, the payment provider's
-- deliveries and captured payments, and the purchases this server starts there.
--
-- Four new tables, nothing existing altered. Rolling back is a NEW forward
-- migration (never SQL by hand against staging or production: the next boot's
-- `migrate deploy` dies on a schema it did not write): DROP the four tables
-- and the four types. Export `payment_events`, `billing_payments` and
-- `billing_checkouts` first -- once a real payment has landed they are tax
-- records. A rollback of the CODE alone is safe: nothing older reads these
-- tables. No payment exists on staging or production at the time of writing.

-- Every statement here creates; nothing waits on a busy table for long, and
-- if something ever did, fail the deploy rather than queue behind it. Prisma
-- runs a migration in one transaction, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "entitlement_subject" AS ENUM ('user', 'org', 'venue');

-- CreateEnum
CREATE TYPE "entitlement_product" AS ENUM ('analytics', 'event_pass', 'venue_pro', 'plus', 'night_pass');

-- CreateEnum
CREATE TYPE "entitlement_source" AS ENUM ('razorpay', 'apple', 'google', 'grant');

-- CreateEnum
CREATE TYPE "billing_checkout_kind" AS ENUM ('subscription', 'order');

-- CreateTable
CREATE TABLE "entitlements" (
    "id" UUID NOT NULL,
    "subject_kind" "entitlement_subject" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "product" "entitlement_product" NOT NULL,
    "event_id" UUID,
    "source" "entitlement_source" NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "external_ref" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "body_sha256" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "error" TEXT,
    "checkout_id" UUID,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_checkouts" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "kind" "billing_checkout_kind" NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "provider_plan_id" TEXT,
    "org_id" UUID NOT NULL,
    "event_id" UUID,
    "plan_key" TEXT NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'created',
    "status_at" TIMESTAMPTZ(6),
    "current_end" TIMESTAMPTZ(6),
    "cancel_at_cycle_end" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_payments" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "provider_payment_id" TEXT NOT NULL,
    "checkout_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "invoice_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'captured',
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entitlements_subject_kind_subject_id_product_idx" ON "entitlements"("subject_kind", "subject_id", "product");

-- CreateIndex
CREATE INDEX "entitlements_event_id_idx" ON "entitlements"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_source_external_ref_key" ON "entitlements"("source", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_body_sha256_key" ON "payment_events"("body_sha256");

-- CreateIndex
CREATE INDEX "payment_events_checkout_id_received_at_idx" ON "payment_events"("checkout_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key" ON "payment_events"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "billing_checkouts_org_id_kind_created_at_idx" ON "billing_checkouts"("org_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "billing_checkouts_event_id_idx" ON "billing_checkouts"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkouts_provider_provider_ref_key" ON "billing_checkouts"("provider", "provider_ref");

-- CreateIndex
CREATE INDEX "billing_payments_checkout_id_captured_at_idx" ON "billing_payments"("checkout_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "billing_payments_provider_provider_payment_id_key" ON "billing_payments"("provider", "provider_payment_id");

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "billing_checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "billing_checkouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The shape of an entitlement, which schema.prisma cannot express and
-- `db push` drops (CLAUDE.md). lib/entitlements.ts writes only rows that
-- satisfy these; the constraints are what a hand-written row meets.

-- Each product belongs to one kind of subject: Analytics and an Event Pass to
-- an organisation, Venue Pro to a venue, Blendn+ and a Night Pass to a person.
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_product_subject" CHECK (
  (product IN ('analytics', 'event_pass') AND subject_kind = 'org')
  OR (product = 'venue_pro' AND subject_kind = 'venue')
  OR (product IN ('plus', 'night_pass') AND subject_kind = 'user')
);

-- An Event Pass names its event, and nothing else does. The foreign key is
-- RESTRICT: a paid pass is the proof somebody paid for that event, and events
-- are soft-deleted, so nothing in the product removes one under it.
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_event_scope" CHECK (
  (product = 'event_pass') = (event_id IS NOT NULL)
);

-- Blendn+ is sold through the stores, never through Razorpay (App Store
-- guideline 3.1.1; owner ruling 2026-10-01; test plan MN-G03).
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_plus_not_razorpay" CHECK (
  NOT (product IN ('plus', 'night_pass') AND source = 'razorpay')
);

-- A paid row names what paid for it. Only a grant has no provider reference.
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_paid_has_ref" CHECK (
  source = 'grant' OR external_ref IS NOT NULL
);

-- A row never ends before it starts. Equal is allowed: ending a row at its
-- own start is how a grant is withdrawn on the day it was made.
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_window" CHECK (
  expires_at IS NULL OR expires_at >= starts_at
);

-- A purchase is in paise, positive, and in rupees.
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_amount" CHECK (
  amount_minor > 0 AND currency = 'INR'
);

-- A subscription names its Razorpay plan and an order does not; only an order
-- (an Event Pass) names an event.
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_shape" CHECK (
  (kind = 'subscription') = (provider_plan_id IS NOT NULL)
  AND (kind = 'order' OR event_id IS NULL)
);

-- One subscription an organisation could still be charged for, at a time. A
-- second admin, a second tab or a double click cannot open a second mandate:
-- lib/billing-actions.ts takes an advisory lock and resumes the open one, and
-- this index is what holds when two requests race past that anyway. Statuses
-- are Razorpay's; `expired`, `cancelled` and `completed` are closed.
CREATE UNIQUE INDEX "billing_checkouts_one_open_subscription_per_org" ON "billing_checkouts" ("org_id")
  WHERE kind = 'subscription' AND status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused');

-- A captured payment, in paise, in rupees.
ALTER TABLE "billing_payments" ADD CONSTRAINT "billing_payments_amount" CHECK (
  amount_minor > 0 AND currency = 'INR'
);
