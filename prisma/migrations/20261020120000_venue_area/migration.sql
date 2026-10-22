-- The neighbourhood of a venue, for Places' "by area" and the area filter. Both
-- nullable: null is "unknown", and scripts/backfill-venue-areas.ts is the only
-- writer (Overture division polygons, never a guess). No CHECK: the two move
-- together because that script writes them together, from `areaSlug`.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN "area" TEXT,
  ADD COLUMN "area_slug" TEXT;

CREATE INDEX "venues_area_slug_idx" ON "venues"("area_slug");

COMMIT;
