-- "Going together" (crews 4-A1, NOTES S4; owner-approved 2026-11-12): a crew marks a night.
-- Additive only: one new table. Nothing existing is altered and nothing is backfilled.
-- One plan per crew per occurrence (the unique); it goes with its crew or its occurrence. The
-- planner is audit only: an erased planner leaves the crew's plan standing (SET NULL).
-- Members only, and never shown outside the crew: hosts and strangers read nothing from it.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- The FKs take brief SHARE ROW EXCLUSIVE locks on crews, event_occurrences and "User".
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "crew_plans" (
  "id"            UUID           NOT NULL DEFAULT gen_random_uuid(),
  "crew_id"       UUID           NOT NULL,
  "occurrence_id" UUID           NOT NULL,
  "created_by"    TEXT,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "crew_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crew_plans_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "crew_plans_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "crew_plans_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "crew_plans_crew_id_occurrence_id_key" ON "crew_plans"("crew_id", "occurrence_id");
CREATE INDEX "crew_plans_occurrence_id_idx" ON "crew_plans"("occurrence_id");
CREATE INDEX "crew_plans_crew_id_created_at_idx" ON "crew_plans"("crew_id", "created_at");
CREATE INDEX "crew_plans_created_by_idx" ON "crew_plans"("created_by");

COMMIT;
