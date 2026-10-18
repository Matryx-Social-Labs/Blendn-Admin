-- The venue page's own facts (redesign): opening hours, a description and amenity
-- labels. All optional: unset is NULL / empty, and the page shows nothing for it.
BEGIN;

ALTER TABLE "venues"
  ADD COLUMN "hours" JSONB,
  ADD COLUMN "description" TEXT,
  ADD COLUMN "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

COMMIT;
