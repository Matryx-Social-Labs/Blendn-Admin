-- Stored reach (step 17 review, db H5): a campaign whose event has ended
-- keeps a number and no roster. `lib/sponsor-reach.ts` counts the distinct
-- per-campaign hashes once, writes the count here, and empties
-- `sponsored_message_sends.recipient_hashes` — the promise the schema has
-- made since the hashes were introduced, never kept until now.
--
-- Additive. Rolling back is a NEW forward migration dropping the constraint
-- and the two columns (never SQL by hand against staging or production);
-- emptied hashes do not come back, which is the point. A rollback of the CODE
-- alone after a sweep has run shows 0 reach for ended campaigns: stop the
-- sweep, do not roll back past it.

-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction (measured, step 17 review), so this file is its own: SET LOCAL
-- holds only inside it, and a failure part-way leaves nothing half-applied.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_sponsored_messages" ADD COLUMN "reach" INTEGER;
ALTER TABLE "event_sponsored_messages" ADD COLUMN "reach_materialised_at" TIMESTAMPTZ(6);

-- Both or neither, and never negative: a count written once, with its time.
ALTER TABLE "event_sponsored_messages" ADD CONSTRAINT "event_sponsored_messages_reach_shape" CHECK (
  ("reach" IS NULL) = ("reach_materialised_at" IS NULL) AND ("reach" IS NULL OR "reach" >= 0)
);

COMMIT;
