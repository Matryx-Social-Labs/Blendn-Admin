-- Multi-day events: one check-in per person PER DAY, not per event.
--
-- `event_check_ins` carried UNIQUE(event_id, user_id), so a five-day conference
-- could hold exactly one row per attendee — and the check-in route's upsert
-- overwrote Monday's timestamp with Tuesday's. "Who came on Wednesday" had no
-- answer, and the attendance record for any returning attendee was destroyed.
--
-- Order matters here. Every existing check-in needs an occurrence to point at
-- before the column can be NOT NULL, and the old constraint cannot be dropped
-- until the new one can hold.

-- 1. The occurrence table.
CREATE TABLE "event_occurrences" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "occurs_on"    DATE NOT NULL,
  "start_time"   TIMESTAMPTZ(6) NOT NULL,
  "end_time"     TIMESTAMPTZ(6) NOT NULL,
  "capacity"     INTEGER,
  "cancelled_at" TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "event_occurrences_event_id_occurs_on_key" ON "event_occurrences" ("event_id", "occurs_on");
CREATE INDEX "event_occurrences_event_id_start_time_idx" ON "event_occurrences" ("event_id", "start_time");
CREATE INDEX "event_occurrences_start_time_idx" ON "event_occurrences" ("start_time");

-- 2. Give every existing event exactly one occurrence, spanning what it already
--    says. A single-evening event is a one-occurrence event, which is why the
--    column can be NOT NULL rather than sprouting a null branch everywhere.
INSERT INTO "event_occurrences" ("event_id", "occurs_on", "start_time", "end_time", "capacity")
SELECT "id", ("start_time" AT TIME ZONE 'UTC')::date, "start_time", "end_time", "max_capacity"
FROM "events";

-- 3. Point existing check-ins at their event's single occurrence.
ALTER TABLE "event_check_ins" ADD COLUMN "occurrence_id" UUID;

UPDATE "event_check_ins" ci
SET "occurrence_id" = o."id"
FROM "event_occurrences" o
WHERE o."event_id" = ci."event_id";

-- A check-in whose event is gone cannot be attributed to a day. There should be
-- none — the FK cascades — but the NOT NULL below would fail on one, and
-- failing a migration on unreachable rows helps nobody.
DELETE FROM "event_check_ins" WHERE "occurrence_id" IS NULL;

ALTER TABLE "event_check_ins" ALTER COLUMN "occurrence_id" SET NOT NULL;
ALTER TABLE "event_check_ins"
  ADD CONSTRAINT "event_check_ins_occurrence_id_fkey"
  FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE;

-- 4. Move uniqueness onto the occurrence.
DROP INDEX IF EXISTS "event_check_ins_event_id_user_id_key";
ALTER TABLE "event_check_ins" DROP CONSTRAINT IF EXISTS "event_check_ins_event_id_user_id_key";
CREATE UNIQUE INDEX "event_check_ins_occurrence_id_user_id_key" ON "event_check_ins" ("occurrence_id", "user_id");
CREATE INDEX "event_check_ins_occurrence_id_status_idx" ON "event_check_ins" ("occurrence_id", "status");

-- 5. Retire the abandoned attempt at this concept.
--    Zero rows and zero references in application code, verified on production
--    before writing this. Leaving it would mean two occurrence tables, one of
--    which nobody uses — which is how the second one gets written.
DROP TABLE IF EXISTS "recurring_events";
