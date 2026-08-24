-- Somebody stood at the door and was turned away.
--
-- A refused check-in produced a 400 and no record, so a wrong pin was invisible
-- until somebody complained -- and most people do not complain, they leave.
--
-- One small table answers three questions: is a pin wrong, is a fence too
-- tight, and how many people tried to get in and could not. The third is a real
-- product signal and nothing else measures it.
--
-- Deliberately NO coordinates. `shortfall_metres` is how far outside they were,
-- which is everything the diagnosis needs and cannot locate anybody. G11 found
-- GPS surviving account deletion on `event_check_ins`; adding a second table
-- with the same problem to fix the first would be absurd.

CREATE TYPE "refusal_reason" AS ENUM (
  'out_of_range', 'no_geofence', 'too_early', 'too_late', 'day_cancelled', 'under_age'
);

CREATE TABLE "check_in_refusals" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"         UUID NOT NULL,
  "occurrence_id"    UUID,
  "user_id"          TEXT NOT NULL,
  "reason"           "refusal_reason" NOT NULL,
  "shortfall_metres" INTEGER,
  "accuracy_metres"  INTEGER,
  "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "check_in_refusals_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  -- Deletes with the user. The rows are diagnostic, not evidence, and the
  -- aggregate a reviewer reads survives the individual rows going.
  CONSTRAINT "check_in_refusals_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE
);

-- The curation-health read: refusals per event, newest first.
CREATE INDEX "check_in_refusals_event_id_created_at_idx"
  ON "check_in_refusals" ("event_id", "created_at");
CREATE INDEX "check_in_refusals_user_id_idx" ON "check_in_refusals" ("user_id");
