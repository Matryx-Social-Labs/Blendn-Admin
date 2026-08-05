-- Venues, venue linkage, and account suspension.
--
-- Until now a "venue" was a nullable free-text string on an event and a "venue
-- owner" was a role whose events happened to carry venue names. Byg Brewski
-- could not exist as a record, so nothing could be said about a place across
-- the events held in it.
--
-- `events.venue_name` is deliberately kept. Most events are at places that are
-- not on the platform: `venue_id` stays null, the free text is the location,
-- and no venue owner gains any rights. Linkage is optional everywhere, and the
-- permission resolver reads an absent venue as "no venue-derived access".
--
-- Suspension replaces deletion as the way to remove a host. Deleting a user
-- cascades their events, every check-in and every chat message, which destroys
-- other people's history in order to punish one person.

CREATE TYPE "venue_status" AS ENUM ('active', 'archived');
CREATE TYPE "venue_link_status" AS ENUM ('auto_linked', 'confirmed', 'disputed');

CREATE TABLE "venues" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "name"       TEXT NOT NULL,
    "address"    TEXT,
    "city"       TEXT,
    "latitude"   DOUBLE PRECISION,
    "longitude"  DOUBLE PRECISION,
    "capacity"   INTEGER,
    -- NULL means unclaimed: the record exists but nobody operates it yet.
    "owner_id"   TEXT,
    "claimed_at" TIMESTAMPTZ(6),
    "status"     "venue_status" NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- SET NULL, not CASCADE: removing an owner orphans the venue. A real place and
-- every event held in it must not disappear because an account was deleted.
ALTER TABLE "venues" ADD CONSTRAINT "venues_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "events" ADD COLUMN "venue_id" UUID;
ALTER TABLE "events" ADD COLUMN "venue_link_status" "venue_link_status";
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "User" ADD COLUMN "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "User" ADD COLUMN "suspended_by" TEXT;
ALTER TABLE "User" ADD COLUMN "suspension_reason" TEXT;

-- Postgres does not index the referencing side of a foreign key, so every
-- cascade or SET NULL would scan without these. See 20260805_fk_indexes.
CREATE INDEX "venues_owner_id_idx" ON "venues"("owner_id");
CREATE INDEX "venues_city_idx" ON "venues"("city");
CREATE INDEX "venues_status_idx" ON "venues"("status");
CREATE INDEX "events_venue_id_idx" ON "events"("venue_id");

-- Deliberately NO backfill of venue_id from venue_name. Matching free text to
-- venue records is a fuzzy, lossy decision ("The Loft" vs "the loft " vs "Loft,
-- Indiranagar") and doing it silently in a migration would hand venue owners
-- operational access to events they were never associated with. Existing events
-- keep their free-text location and stay unlinked until someone links them.
