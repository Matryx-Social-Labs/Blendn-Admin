-- The redesign's server facts: the venue page's own data (opening hours, a
-- description, the amenities it offers) and, per Blend side, when somebody
-- tapped reveal. All optional / additive; nothing is rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "venues"
  ADD COLUMN "hours" JSONB,
  ADD COLUMN "description" TEXT;

-- A venue's amenities are the same vocabulary events tick from.
CREATE TABLE "venue_amenities" (
  "venue_id" UUID NOT NULL,
  "amenity_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_amenities_pkey" PRIMARY KEY ("venue_id", "amenity_id")
);
CREATE INDEX "venue_amenities_amenity_id_idx" ON "venue_amenities"("amenity_id");
ALTER TABLE "venue_amenities"
  ADD CONSTRAINT "venue_amenities_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "venue_amenities_amenity_id_fkey" FOREIGN KEY ("amenity_id") REFERENCES "amenities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Reveal taps per Blend side (A is always a crew; B a crew or the one matched person).
ALTER TABLE "blends"
  ADD COLUMN "a_revealed_at" TIMESTAMPTZ(6),
  ADD COLUMN "b_revealed_at" TIMESTAMPTZ(6);

COMMIT;
