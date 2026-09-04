-- `event_reports` gains the reviewer columns its two sibling tables already
-- have. It lacked them because it had no queue to be reviewed in: zero writers
-- and zero readers since the table was created.
--
-- Nullable and with no default, matching `user_reports` and `message_reports`:
-- a report that nobody has looked at yet has no reviewer, and that absence is
-- the pending state rather than a missing value.
ALTER TABLE "event_reports" ADD COLUMN IF NOT EXISTS "reviewed_by" TEXT;
ALTER TABLE "event_reports" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMPTZ(6);
