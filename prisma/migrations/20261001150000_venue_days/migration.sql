-- Venue days (step 3, plan v2 §3 and §12.1 F1/F2/F10/F11).
--
-- Every active venue is live from day one. A venue's live room is a hidden
-- `events` row of kind `venue_day`: one per venue per local day, created by
-- lib/venue-day.ts the first time somebody goes live there that day (step 4),
-- reusing occurrences, check-ins, presence and the chat room unchanged.
--
-- Nothing here creates a venue day. Every existing row becomes kind 'event'
-- through the default, so no reader sees a difference until step 4 ships.
--
-- Rolling back:
--   1. DELETE FROM events WHERE kind = 'venue_day' (cascades their check-ins,
--      sessions and rooms -- export first if anybody has gone live).
--   2. DROP INDEX events_one_venue_day_per_day; ALTER TABLE events DROP COLUMN
--      kind; DROP TYPE event_kind.
--   3. ALTER TABLE venues DROP CONSTRAINT venues_day_reset_hour_range,
--      DROP CONSTRAINT venues_timezone_known, DROP COLUMN day_reset_hour,
--      DROP COLUMN timezone; ALTER TABLE event_check_ins DROP COLUMN expires_at.
--   4. DROP TRIGGER system_user_is_permanent ON "User"; DROP FUNCTION
--      system_user_is_permanent(); then the system user may be deleted.
-- Code rolled back without step 1 shows the venue days as ordinary events
-- everywhere, which is the leak the kind column exists to stop.

CREATE TYPE "event_kind" AS ENUM ('event', 'venue_day');

ALTER TABLE "events" ADD COLUMN "kind" "event_kind" NOT NULL DEFAULT 'event';

-- One venue day per venue per local day. The day's start is computed from the
-- venue's zone and reset hour, so (venue, start) names the day. Partial, so it
-- says nothing about events, and so it exists only here: schema.prisma cannot
-- express it, and a `db push` database has none (CLAUDE.md). lib/venue-day.ts
-- matches the race on this NAME (lib/prisma-errors.ts), never on meta.target.
-- It is also the index the venue-day lookup seeks on.
CREATE UNIQUE INDEX "events_one_venue_day_per_day"
  ON "events" ("venue_id", "start_time")
  WHERE "kind" = 'venue_day';

ALTER TABLE "venues"
  ADD COLUMN "day_reset_hour" SMALLINT NOT NULL DEFAULT 6,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

ALTER TABLE "venues" ADD CONSTRAINT "venues_day_reset_hour_range"
  CHECK ("day_reset_hour" BETWEEN 0 AND 23);

-- A zone Postgres cannot read raises 22023 here rather than at the first Go
-- Live. timezone(text, timestamptz) is IMMUTABLE, so it may sit in a CHECK.
-- lib/venue-day.ts throws a RangeError on any zone it still cannot read.
ALTER TABLE "venues" ADD CONSTRAINT "venues_timezone_known"
  CHECK ((TIMESTAMPTZ '2000-01-01 00:00:00+00' AT TIME ZONE "timezone") IS NOT NULL);

-- When a Go Live window ends (step 4). Null for event check-ins.
ALTER TABLE "event_check_ins" ADD COLUMN "expires_at" TIMESTAMPTZ(6);

-- The owner of every venue day (F2). Not a person: events.organizer_id is NOT
-- NULL and cascades on a hard delete, so if whoever went live first owned the
-- day, deleting their account would delete the day and everybody's check-ins
-- and messages with it. Created here rather than by a seed so it exists on
-- every environment the moment the deploy's `migrate deploy` runs, before the
-- server binds -- and in every itest database built with db:migrate.
--
-- No password, an address on the reserved .invalid TLD (RFC 2606) nobody can
-- receive mail at or verify for a Google/Apple account, no profile: it cannot
-- sign in on either surface. `attendee`, the role with no dashboard and no
-- host powers. The host shown for a venue day is the venue (lib/event-host.ts).
INSERT INTO "User" ("id", "name", "email", "role", "updatedAt")
VALUES ('blendn-system', 'Blendn', 'system@blendn.invalid', 'attendee', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
-- On the id only. Somebody already holding the address would make this fail
-- the deploy, loudly, rather than skip the row and fail the first Go Live on
-- the foreign key.


-- And it is never deleted: every venue day would cascade with it.
CREATE FUNCTION "system_user_is_permanent"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'blendn-system owns every venue day and cannot be deleted'
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER "system_user_is_permanent"
  BEFORE DELETE ON "User"
  FOR EACH ROW WHEN (OLD."id" = 'blendn-system')
  EXECUTE FUNCTION "system_user_is_permanent"();
