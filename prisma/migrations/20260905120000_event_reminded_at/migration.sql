-- The "starting soon" reminder had no idempotency.
--
-- It selects events whose start falls inside a 15-minute window, so any
-- scheduler running more often than that re-sent the same reminder on every
-- pass. Nothing scheduled it at all, which is the only reason nobody received
-- three pushes.
--
-- Nullable with no default: null is "not yet reminded", and every existing row
-- is correctly in that state.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "reminded_at" TIMESTAMPTZ(6);

-- The sweep's predicate: upcoming, unreminded. Partial, because a reminded
-- event is never looked at again and there is no reason to index the whole
-- table for a query that only ever wants the nulls.
CREATE INDEX IF NOT EXISTS "events_reminder_pending_idx"
  ON "events"("start_time")
  WHERE "reminded_at" IS NULL AND "deleted_at" IS NULL;
