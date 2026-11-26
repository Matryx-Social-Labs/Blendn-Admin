-- The host's morning results mail (SCRUM-1282): when it went, claimed before the send like rating_requested_at.
-- Expand only: nullable, no default, so every existing row reads "not yet mailed" and the sweep's 34 h lookback keeps
-- the archive out of it. No index: the sweep reads through "events_status_end_time_idx" over a 34 h window.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "results_mailed_at" TIMESTAMPTZ(6);
COMMIT;
