-- Blendn+ (step 11, plan v2 §5 and §9.3): what the RevenueCat webhook needs to
-- keep a person's entitlement in the order things happened at the store, and
-- who invited whom (the referral reward).
--
-- Additive: two nullable columns on `entitlements` (no rewrite, no default) and
-- one new table. Rolling back is a NEW forward migration (never SQL by hand
-- against staging or production: the next boot's `migrate deploy` dies on a
-- schema it did not write): DROP the table and the two columns. A rollback of
-- the CODE alone is safe: older code reads neither column nor the table.

-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction (measured, step 17 review), so this file is its own: SET LOCAL
-- applies, and a failure half-way applies nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The store's time (RevenueCat `event_timestamp_ms`) of the event that last
-- set this row's window, and of the one that last set its owner. A delivery
-- older than either never moves it: an old RENEWAL retried after a refund
-- cannot give access back, and an old TRANSFER cannot take it away from the
-- person a newer one gave it to. Two clocks, not one, so a renewal delayed past
-- a transfer still extends the window it paid for. NULL on every row this
-- webhook did not write (Razorpay's, grants).
ALTER TABLE "entitlements" ADD COLUMN "window_event_at" TIMESTAMPTZ(6);
ALTER TABLE "entitlements" ADD COLUMN "owner_event_at" TIMESTAMPTZ(6);

-- Who brought whom: the first invite link a person used (plan v2 §9.3,
-- "3 friends who check in = 1 month"). One row per invitee, ever, so a friend
-- counts once for one inviter. CASCADE for completeness; accounts are
-- tombstoned rather than deleted, and the erasure deletes these rows itself.
CREATE TABLE "referrals" (
    "invitee_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("invitee_id"),
    CONSTRAINT "referrals_not_self" CHECK ("invitee_id" <> "inviter_id")
);

CREATE INDEX "referrals_inviter_id_idx" ON "referrals"("inviter_id");

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_invitee_id_fkey"
  FOREIGN KEY ("invitee_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_inviter_id_fkey"
  FOREIGN KEY ("inviter_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
