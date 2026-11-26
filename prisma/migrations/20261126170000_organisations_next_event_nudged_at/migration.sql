-- The "list your next" nudge (SCRUM-1284): when it was last claimed (lib/next-night-nudge.ts), set before the send so an
-- organisation gets at most one in 30 days. Expand only: nullable, no default, catalog only, no rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "next_event_nudged_at" TIMESTAMPTZ(6);
COMMIT;
