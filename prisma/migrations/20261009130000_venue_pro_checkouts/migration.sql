-- Venue Pro (step 17, plan v2 §9.1b): a subscription is bought for one venue,
-- by the organisation that owns it, so a purchase names the venue it is for.
--
-- Additive, plus one index replaced by two. Rolling back is a NEW forward
-- migration (never SQL by hand against staging or production): restore the
-- org-wide `billing_checkouts_one_open_subscription_per_org`, drop the venue
-- one, the constraint and the column. Export `billing_checkouts` first if a
-- venue purchase has landed: it is a tax record. A rollback of the CODE alone
-- is safe while no venue purchase exists: older code reads no `venue_id`.

-- Prisma runs a migration in one transaction, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';

-- RESTRICT: a purchase is a tax record, and venues are retired (deleted_at),
-- never deleted, by the product.
ALTER TABLE "billing_checkouts" ADD COLUMN "venue_id" UUID;
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_venue_id_fkey"
  FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "billing_checkouts_venue_id_kind_created_at_idx" ON "billing_checkouts"("venue_id", "kind", "created_at");

-- Only a subscription is for a venue (Venue Pro is sold monthly or yearly).
ALTER TABLE "billing_checkouts" ADD CONSTRAINT "billing_checkouts_venue_shape" CHECK (
  "venue_id" IS NULL OR "kind" = 'subscription'
);

-- One subscription that could still charge per organisation (Analytics) and,
-- separately, per venue (Venue Pro): an organisation owning two venues may
-- have Pro on both, and never two mandates for one. Same statuses as before
-- (lib/billing.ts OPEN_SUBSCRIPTION_STATUSES).
DROP INDEX "billing_checkouts_one_open_subscription_per_org";
CREATE UNIQUE INDEX "billing_checkouts_one_open_subscription_per_org" ON "billing_checkouts" ("org_id")
  WHERE kind = 'subscription' AND venue_id IS NULL
    AND status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused');
CREATE UNIQUE INDEX "billing_checkouts_one_open_subscription_per_venue" ON "billing_checkouts" ("venue_id")
  WHERE kind = 'subscription' AND venue_id IS NOT NULL
    AND status IN ('created', 'authenticated', 'active', 'pending', 'halted', 'paused');
