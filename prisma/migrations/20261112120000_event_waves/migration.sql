-- Recorded waves (SCRUM-1042, SCRUM-1050; owner ruling 2026-11-12: Wave replaces Like for people).
-- Additive only: one new table, its indexes and one CHECK. No existing table is altered and nothing is
-- backfilled -- `event_likes` is deliberately NOT copied in (approval 11: an old like stays hidden and
-- only counts if the other person waves back; `lib/waves.ts` reads it for that).
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- The FKs take a SHARE ROW EXCLUSIVE lock on "User" and "events" briefly; lock_timeout makes a queued
-- deploy fail fast rather than stall the live reads behind it.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "event_waves" (
  "id"         UUID           NOT NULL DEFAULT gen_random_uuid(),
  "event_id"   UUID           NOT NULL,
  "from_id"    TEXT           NOT NULL,
  "to_id"      TEXT           NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_waves_pkey" PRIMARY KEY ("id"),
  -- Nobody waves at themselves; the route refuses it first, this keeps every other writer honest.
  CONSTRAINT "event_waves_not_self" CHECK ("from_id" <> "to_id"),
  CONSTRAINT "event_waves_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_waves_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "event_waves_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "event_waves_event_id_from_id_to_id_key" ON "event_waves"("event_id", "from_id", "to_id");
CREATE INDEX "event_waves_event_id_to_id_created_at_idx" ON "event_waves"("event_id", "to_id", "created_at" DESC);
CREATE INDEX "event_waves_from_id_created_at_idx" ON "event_waves"("from_id", "created_at");
CREATE INDEX "event_waves_to_id_idx" ON "event_waves"("to_id");

COMMIT;
