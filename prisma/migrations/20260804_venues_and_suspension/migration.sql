-- RENAMED from `20260805_venues_and_suspension` (now 20260804_), and made idempotent. Why:
--
-- `20260805_organisations` sorted first -- same date, `o` before `v` -- and
-- referenced the `venues` table this migration creates. So replaying the chain
-- in order failed with `relation "venues" does not exist`.
--
-- Second instance of the same defect, and the cause is worth naming: five
-- migrations were written on one day with no time component in their names, so
-- their order was decided by alphabet rather than by intent. `organisations`,
-- `org_onboarding` and `venues_and_suspension` all landed together, and the
-- dependency order happened to be the reverse of the alphabetical one.
--
-- It was invisible for the same reason as the other: production and staging
-- were `db push`-ed before any of these ran, so every migration was recorded
-- as applied without its position ever being exercised.
--
-- Renamed rather than edited, because Prisma checksums applied migrations --
-- editing in place breaks `migrate deploy` everywhere it has already run.
-- Under a new name existing environments run it once more, which is why every
-- statement here is now a no-op against a database that already has these
-- objects.

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

DO $$ BEGIN
    CREATE TYPE "venue_status" AS ENUM ('active', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
    CREATE TYPE "venue_link_status" AS ENUM ('auto_linked', 'confirmed', 'disputed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "venues" (
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
DO $$ BEGIN
    ALTER TABLE "venues" ADD CONSTRAINT "venues_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venue_id" UUID;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venue_link_status" "venue_link_status";
DO $$ BEGIN
    ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspended_by" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "suspension_reason" TEXT;

-- Postgres does not index the referencing side of a foreign key, so every
-- cascade or SET NULL would scan without these. See 20260805_fk_indexes.
CREATE INDEX IF NOT EXISTS "venues_owner_id_idx" ON "venues"("owner_id");
CREATE INDEX IF NOT EXISTS "venues_city_idx" ON "venues"("city");
CREATE INDEX IF NOT EXISTS "venues_status_idx" ON "venues"("status");
CREATE INDEX IF NOT EXISTS "events_venue_id_idx" ON "events"("venue_id");

-- Deliberately NO backfill of venue_id from venue_name. Matching free text to
-- venue records is a fuzzy, lossy decision ("The Loft" vs "the loft " vs "Loft,
-- Indiranagar") and doing it silently in a migration would hand venue owners
-- operational access to events they were never associated with. Existing events
-- keep their free-text location and stay unlinked until someone links them.
