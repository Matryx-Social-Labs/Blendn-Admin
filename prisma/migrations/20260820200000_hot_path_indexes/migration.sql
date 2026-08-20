-- Indexes for the predicates the product actually runs hottest.
--
-- Each of these serves a query that exists today and scans. None changes a
-- schema shape, so this migration is additive and reversible by dropping.
--
-- Deliberately NOT here: the GIN index for event full-text search, and the
-- lower(city) indexes for the case-insensitive city lookups. Both are real
-- wins, and both are expressions Prisma cannot represent in schema.prisma --
-- so creating them here would leave the database holding indexes the datamodel
-- does not know about, which `prisma db push` (used for local iteration) would
-- then drop. They need a drift policy first. See R8.

-- The 5-second live-ops tick asks two questions this serves: how many people
-- arrived in the last ten minutes, and the arrival histogram. Both scanned
-- every check-in row for the event, twelve times a minute, per watched event.
-- `lib/live-snapshot.ts` claims "the queries are all indexed and scoped to one
-- event" -- scoped yes, indexed no.
CREATE INDEX IF NOT EXISTS "event_check_ins_event_id_check_in_time_idx"
  ON "event_check_ins"("event_id", "check_in_time");

-- The Hotspots feed bounding-boxes on venue coordinates. `events` has carried
-- the matching index since it shipped; `venues` did not, so the venue-proximity
-- query was the one geo lookup in the product doing a sequential scan.
CREATE INDEX IF NOT EXISTS "venues_latitude_longitude_idx"
  ON "venues"("latitude", "longitude");

-- `User` had no index at all. The admin overview scans it five times per page
-- load -- total users, hosts by role, three nested funnel counts, and the
-- eight-week signup series -- on a force-dynamic page.
CREATE INDEX IF NOT EXISTS "User_createdAt_idx" ON "User"("createdAt");
CREATE INDEX IF NOT EXISTS "User_role_idx" ON "User"("role");

-- `profiles` had none either, and the admin funnel semi-joins into it three
-- times per load on `profile: { onboarded: true }`.
CREATE INDEX IF NOT EXISTS "profiles_onboarded_idx" ON "profiles"("onboarded");
