-- The unchecked-photo sweep (SCRUM-732) takes the least recently attempted row
-- first, so a photo that never gets a verdict cannot hold the queue against the
-- ones behind it. `attempts` counts passes, `last_attempted_at` orders them.
-- ADD COLUMN with a constant default is metadata-only on PG 11+, and the nullable
-- column rewrites nothing. photo_checks holds a row per profile photo ever
-- uploaded: tens of thousands, scanned by no one but the sweep (checked = false is
-- served by the existing (checked, created_at) index).
-- Wrapped: `migrate deploy` applies statement by statement, so a failure part-way
-- would leave the table half-changed and block every later deploy.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "photo_checks" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "photo_checks" ADD COLUMN IF NOT EXISTS "last_attempted_at" TIMESTAMPTZ(6);

COMMIT;
