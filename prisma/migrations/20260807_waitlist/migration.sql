-- Waitlist for events with a stated capacity.
--
-- RSVP enforced no capacity at all: anyone could say "going" to a 100-capacity
-- room, without limit, which made `going` useless as a planning number and made
-- turn-up a ratio against something arbitrary.
--
-- Adding a value to an enum is not transactional in Postgres before 12 and
-- cannot be done inside a transaction block in some versions; `IF NOT EXISTS`
-- makes it safe to re-run either way.
ALTER TYPE "rsvp_status" ADD VALUE IF NOT EXISTS 'waitlisted';

-- Promotion is "oldest waitlisted first", so the order people joined has to be
-- cheap to read for one event.
CREATE INDEX IF NOT EXISTS "event_rsvps_event_id_status_created_at_idx"
  ON "event_rsvps" ("event_id", "status", "created_at");
