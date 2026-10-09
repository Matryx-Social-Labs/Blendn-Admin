-- Money (step 16, plan v2 §9 and §9.1b): entitlements, the payment provider's
-- deliveries, and the purchases this server starts there.
--
-- Three new tables, nothing existing altered. Rolling back is a NEW forward
-- migration (never SQL by hand against staging or production: the next boot's
-- `migrate deploy` dies on a schema it did not write): DROP the three tables
-- and the four types. Export `payment_events` and `billing_checkouts` first --
-- once a real payment has landed they are tax records. A rollback of the CODE
-- alone is safe: nothing older reads these tables.

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

-- CreateIndex
CREATE INDEX "entitlements_subject_kind_subject_id_product_idx" ON "entitlements"("subject_kind", "subject_id", "product");

-- CreateIndex
CREATE INDEX "entitlements_event_id_idx" ON "entitlements"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_source_external_ref_key" ON "entitlements"("source", "external_ref");

-- CreateIndex
CREATE INDEX "payment_events_checkout_id_idx" ON "payment_events"("checkout_id");

-- CreateIndex
CREATE INDEX "payment_events_type_received_at_idx" ON "payment_events"("type", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_provider_event_id_key" ON "payment_events"("provider", "provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_checkouts_provider_ref_key" ON "billing_checkouts"("provider_ref");

-- CreateIndex
CREATE INDEX "billing_checkouts_org_id_kind_created_at_idx" ON "billing_checkouts"("org_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "billing_checkouts_event_id_idx" ON "billing_checkouts"("event_id");

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "billing_checkouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- An Event Pass names its event, and nothing else does.
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
