-- Flow 5 · P-A (SCRUM-1042): why a person is at a work-lens event ("Here to hire / find work / build / learn").
-- Additive only: a new enum, and a nullable column with no default on a live table (metadata-only, no rewrite).
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- lock_timeout so a queued ALTER on event_match_preferences fails fast rather than stalling the room's reads.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "work_intent" AS ENUM ('hire', 'find_work', 'build', 'learn');
ALTER TABLE "event_match_preferences" ADD COLUMN "work_intent" "work_intent";

COMMIT;
