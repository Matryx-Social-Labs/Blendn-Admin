-- A venue's floors (step 17; owner, 2026-10-09, 3D map): how tall the app's
-- map draws the venue's building, overriding the building data's height.
--
-- Additive and nullable: null means "use the map's own height". Rolling back
-- is a NEW forward migration dropping the constraint and the column (never SQL
-- by hand against staging or production). A rollback of the CODE alone is
-- safe: older code reads neither.
--
-- `prisma migrate deploy` sends a file statement by statement, outside any
-- transaction (measured, step 17 review): `SET LOCAL` on its own does
-- nothing, and a failure half-way leaves the first statements applied. So the
-- file is its own transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN "floors" SMALLINT;

-- A building has at least one floor, and none has more than 200 (the tallest
-- has 163). schema.prisma cannot express a CHECK and `db push` drops it, so it
-- lives here; lib/venue-actions.ts refuses the same range with a sentence.
ALTER TABLE "venues" ADD CONSTRAINT "venues_floors_range"
  CHECK ("floors" IS NULL OR "floors" BETWEEN 1 AND 200);

COMMIT;
