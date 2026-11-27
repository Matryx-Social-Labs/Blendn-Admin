-- A moderator's delisting sticks (SCRUM-1394): when and by whom an event was delisted from a report
-- (app/dashboard/moderation/reports/actions.ts). While `delisted_at` is set, `updateEventTracked` refuses a visibility
-- change to anybody but an admin, and an admin's move back to public clears both.
-- `delisted_by` is the moderator's User.id, plain text like every other *_by column: no foreign key, so deleting a
-- staff account neither blocks nor erases the record (the audit row names them too).
-- Expand only: two nullable columns, no default, no backfill, catalog only, no rewrite. Wrapped, because
-- `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "delisted_at" TIMESTAMPTZ(6);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "delisted_by" TEXT;
COMMIT;
