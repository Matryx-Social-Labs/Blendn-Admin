-- "Offers from places" is promotional consent, so it defaults OFF for every
-- profile made from now on (S-5, decision D21; App Store guideline 4.5.4).
--
-- The DEFAULT only. Existing rows keep the value they hold: turning off a
-- setting people may already rely on is a product decision, not a migration's.
-- Catalogue-only (no table rewrite): ALTER COLUMN ... SET DEFAULT takes an
-- ACCESS EXCLUSIVE lock for an instant, so lock_timeout bounds the wait behind
-- a long transaction rather than queueing every profile read behind it.
--
-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction, so this file is its own: SET LOCAL applies, and a failure
-- applies nothing. Rolling back is a NEW forward migration setting it to true.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "profiles" ALTER COLUMN "offers_from_places" SET DEFAULT false;
COMMIT;
