-- SCRUM-1275: when the one mail 14 days before an organisation's free Analytics ends was claimed
-- (lib/free-window-mail.ts). Set before the send, so a second pass or a second replica sends nothing.
-- Nullable with no default: catalog only, no rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "organisations" ADD COLUMN IF NOT EXISTS "analytics_free_ending_mailed_at" TIMESTAMPTZ(6);

COMMIT;
