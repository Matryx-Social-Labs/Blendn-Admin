-- Post-event insights outlive the purges (SCRUM-1051, step 4 of the owner-approved insights plan).
-- Additive only: one new table. Nothing existing is altered and nothing is backfilled -- the
-- lifecycle sweeper freezes each event before the 30-day purge (Tonight's answers, work intent)
-- or the 180-day purge (Lobby posts and their asks) reaches it, and both purges wait for the row.
-- `counts` holds aggregate counts only, never an id or any words (insight-tallies.itest.ts).
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- The FK takes a SHARE ROW EXCLUSIVE lock on "events" briefly; lock_timeout fails a queued deploy fast.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "event_insight_tallies" (
  "event_id"  UUID           NOT NULL,
  "counts"    JSONB          NOT NULL,
  "frozen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_insight_tallies_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "event_insight_tallies_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
