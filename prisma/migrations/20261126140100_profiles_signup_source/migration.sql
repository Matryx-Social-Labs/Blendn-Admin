-- SCRUM-1273: where an account came from (`ACQUISITION_SOURCES`, lib/product-events.ts), written once: the first
-- source the app sends wins. Nullable with no default: catalog only, no rewrite. Installed builds send none.
-- NOT VALID and never validated, as 20261126140000_event_rsvps_source: every row is NULL when it is added.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "signup_source" TEXT;

ALTER TABLE "profiles"
  ADD CONSTRAINT "profiles_signup_source_known"
  CHECK ("signup_source" IN ('door', 'link', 'invite', 'web', 'share')) NOT VALID;

COMMIT;
