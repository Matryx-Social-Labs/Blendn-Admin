-- SCRUM-1273: where an RSVP came from (`ACQUISITION_SOURCES`, lib/product-events.ts), written on the row's first
-- insert only. Nullable with no default: catalog only, no rewrite. Installed builds send no source and write NULL.
-- NOT VALID and never validated: every row is NULL when it is added, so it holds already, and every row written
-- from the COMMIT on is checked. Validating would scan a hot table for nothing. One table per file, so the
-- ACCESS EXCLUSIVE lock on one is never held while waiting for the other (ecc database-reviewer).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_rsvps" ADD COLUMN IF NOT EXISTS "source" TEXT;

ALTER TABLE "event_rsvps"
  ADD CONSTRAINT "event_rsvps_source_known"
  CHECK ("source" IN ('door', 'link', 'invite', 'web', 'share')) NOT VALID;

COMMIT;
