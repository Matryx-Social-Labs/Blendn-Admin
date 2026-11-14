-- A crew's own hashtags (owner 2026-11-14, pick A): up to 5 tags of free text, where it was 3 of
-- ten curated slugs. The text itself (1–24 characters, letters/digits/_/emoji, moderated) is the
-- app's to check (lib/crews/crews.ts `crewTags`); the count is held here as before.
-- Widening only: every existing row (at most 3) passes the new check, nothing is backfilled, and
-- a build still on 3 writes rows the new check accepts.
-- Wrapped: `migrate deploy` is not transactional. One ALTER, so the old check is never gone
-- without the new one; the re-check reads the crews table under its lock (small, and bounded by
-- the lock timeout).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "crews"
  DROP CONSTRAINT "crews_tags_max",
  ADD CONSTRAINT "crews_tags_max" CHECK (cardinality("tags") <= 5);

COMMIT;
