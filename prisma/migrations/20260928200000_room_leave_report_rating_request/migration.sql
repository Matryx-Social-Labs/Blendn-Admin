-- Leaving a room, reporting a room, and the "rate who you met" push.
--
-- Hand-written and additive only: one enum value, three nullable columns and
-- one partial index. Nothing is dropped, rewritten or backfilled, so it is safe
-- under Railway's pre-deploy `prisma migrate deploy` and safe to re-run (every
-- statement is IF NOT EXISTS).
--
-- The enum value is not used by anything in this migration, so adding it inside
-- the migration's transaction is fine on Postgres 12+ (20260928000000_friends
-- does the same).

-- The bell row for the push that asks attendees to rate the night.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'rating_request';

-- A person who left a room themselves. Null for the sweeper's and account
-- deletion's `left`, which are not a choice and keep their existing behaviour.
ALTER TABLE "chat_group_members" ADD COLUMN IF NOT EXISTS "left_at" TIMESTAMPTZ(6);

-- A report about an event's room rather than the event. No foreign key: the
-- report has to outlive the room, as message_reports.message_id does.
ALTER TABLE "event_reports" ADD COLUMN IF NOT EXISTS "chat_group_id" UUID;

-- Idempotency for the rating request, as reminded_at is for the reminder.
-- Nullable with no default: every existing row is correctly "not yet asked",
-- and the sender only looks back a few hours, so old events are never swept up.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "rating_requested_at" TIMESTAMPTZ(6);

-- The sweep's predicate: recently ended, not yet asked. Partial, because an
-- event that has been asked is never looked at again.
CREATE INDEX IF NOT EXISTS "events_rating_request_pending_idx"
  ON "events"("end_time")
  WHERE "rating_requested_at" IS NULL AND "deleted_at" IS NULL;
