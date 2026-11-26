-- Quiet hours, 23:00-09:00 on the recipient's clock (SCRUM-1276, launch gate 7): a push held at night keeps its bell
-- row with the time it rings (lib/quiet-hours.ts, released by the reminder loop). Additive: one nullable column with no
-- default, so Postgres changes the catalogue only, rewrites no row and holds the ACCESS EXCLUSIVE lock for
-- milliseconds; the lock_timeout makes the deploy give up rather than queue behind a long query on "notifications".
-- Wrapped, because `migrate deploy` is not transactional. Its index is the next migration, alone, CONCURRENTLY.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "notifications" ADD COLUMN "held_until" TIMESTAMPTZ(6);

COMMIT;
