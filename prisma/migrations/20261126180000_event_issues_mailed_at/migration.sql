-- The host's critical live alert mail (SCRUM-1286): when an opening was mailed (lib/live-alert-mail.ts), claimed before
-- the send and given back if nobody got it, so a flapping condition mails at most once in 30 minutes per event and kind.
-- Expand only: nullable, no default, catalog only, no rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "event_issues" ADD COLUMN IF NOT EXISTS "mailed_at" TIMESTAMPTZ(6);
COMMIT;
