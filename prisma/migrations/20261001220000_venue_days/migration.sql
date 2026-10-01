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
-- Rolling back: as a NEW forward migration that reverts this one, deployed
-- like any other -- never SQL run by hand against staging or production (the
-- next boot's `migrate deploy` dies on a schema it did not write). In order:
--   1. DELETE FROM message_reports WHERE message_type = 'group' AND message_id
--      IN (the chat_messages of venue-day rooms). No foreign key: they would
--      be left pointing at nothing.
--   2. DELETE FROM events WHERE kind = 'venue_day' (cascades their check-ins,
--      sessions, occurrences and rooms -- export first if anybody went live).
--   3. DROP INDEX events_one_venue_day_per_day and
--      event_check_ins_expires_at_idx; ALTER TABLE events DROP CONSTRAINT
--      events_venue_day_shape, DROP COLUMN kind; DROP TYPE event_kind.
--   4. ALTER TABLE venues DROP CONSTRAINT venues_day_reset_hour_range,
--      DROP CONSTRAINT venues_timezone_known, DROP COLUMN day_reset_hour,
--      DROP COLUMN timezone; ALTER TABLE event_check_ins DROP COLUMN expires_at.
--   5. DROP TRIGGER system_user_is_permanent ON "User"; DROP FUNCTION
--      system_user_is_permanent(); then the system user may be deleted.
-- A rollback of the CODE alone is safe only while no venue day exists, which
-- is until step 4's Go Live ships: after that, old code shows every venue day
-- as an ordinary published event, which is the leak `kind` exists to stop.

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

-- A venue day always has its venue, and is never listed. The venue makes a
-- hard delete of a venue with days loud (the FK's SET NULL would otherwise
-- orphan them outside the unique index); `unlisted` keeps every reader that
-- asks only for public events blind to one even if it forgot the kind.
ALTER TABLE "events" ADD CONSTRAINT "events_venue_day_shape"
  CHECK ("kind" = 'event' OR ("venue_id" IS NOT NULL AND "visibility" = 'unlisted'));

ALTER TABLE "venues"
  ADD COLUMN "day_reset_hour" SMALLINT NOT NULL DEFAULT 6,
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

ALTER TABLE "venues" ADD CONSTRAINT "venues_day_reset_hour_range"
  CHECK ("day_reset_hour" BETWEEN 0 AND 23);

-- The shape of an IANA name ("Area/Location", or UTC). It keeps out what
-- Postgres reads and Node does not ("UTC+5", "<+05>-5", "IST"), which would
-- pass a stricter check here and throw at the first Go Live. Whether the name
-- exists is the app's to decide, not the database image's tzdata:
-- lib/venue-day.ts throws a RangeError on a zone it cannot read, and a venue
-- editor must validate with Intl before it writes one.
-- The default puts every existing venue in India, which they all are; a venue
-- abroad must be given its zone.
ALTER TABLE "venues" ADD CONSTRAINT "venues_timezone_known"
  CHECK ("timezone" = 'UTC' OR "timezone" ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$');

-- When a Go Live window ends (step 4). Null for event check-ins, so the index
-- the expiry sweep will read holds only the Go Live rows.
ALTER TABLE "event_check_ins" ADD COLUMN "expires_at" TIMESTAMPTZ(6);
CREATE INDEX "event_check_ins_expires_at_idx" ON "event_check_ins" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

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
