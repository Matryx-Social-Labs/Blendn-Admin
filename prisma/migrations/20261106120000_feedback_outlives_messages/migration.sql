-- Owner, 2026-11-06: the 180-day purge keeps an event's anonymous feedback figures.
-- A feedback row outlives its message (detached by the purge, which nulls message_id and
-- corrected_by first); account deletion still cascades it with the message.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
BEGIN;

ALTER TABLE "event_feedback" ALTER COLUMN "message_id" DROP NOT NULL;

CREATE TABLE "event_feedback_tallies" (
  "event_id" UUID NOT NULL,
  "population" INTEGER NOT NULL,
  "contributors" JSONB NOT NULL,
  "frozen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_feedback_tallies_pkey" PRIMARY KEY ("event_id")
);
ALTER TABLE "event_feedback_tallies" ADD CONSTRAINT "event_feedback_tallies_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
