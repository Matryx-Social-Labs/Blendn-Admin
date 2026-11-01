-- SCRUM-442 (owner row A-10; decided 2026-11-01 under delegation; reverse if wanted).
-- `event_ratings.review` was accepted and stored, and read by nothing: the app never
-- sent it and no screen showed it. Text with no purpose is personal data with no purpose.
-- BEGIN/COMMIT: `migrate deploy` runs statement by statement, so a failure must not strand it.
BEGIN;
ALTER TABLE "event_ratings" DROP COLUMN IF EXISTS "review";
COMMIT;
