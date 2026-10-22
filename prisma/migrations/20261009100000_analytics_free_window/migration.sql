-- Analytics (step 16, part 2): the free window, written once, and the index an
-- event's views → RSVPs funnel reads.
--
-- Additive. Rolling back is a NEW forward migration dropping the two columns
-- and the index (never SQL by hand against staging or production). A rollback
-- of the CODE alone is safe: older code reads neither.

-- Prisma runs a migration in one transaction, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';

-- When Analytics stops being free, and the event that started the clock.
-- Written once by lib/analytics-access.ts and never moved, so soft-deleting
-- that event cannot restart the 30 days. No foreign key: a record of a
-- decision, kept whatever happens to the event.
ALTER TABLE "organisations"
  ADD COLUMN "analytics_free_until" TIMESTAMPTZ(6),
  ADD COLUMN "first_free_event_id" UUID;

-- An event's app views, by person. Without it the funnel scanned
-- product_events (174 ms at 3.5M rows in review; 1.25 ms with it). Partial:
-- most product events name no entity. schema.prisma cannot express INCLUDE or
-- WHERE, so it lives here; the model's comment points at it.
CREATE INDEX "product_events_event_viewed_by_entity" ON "product_events" ("entity_id", "name") INCLUDE ("user_id")
  WHERE "entity_id" IS NOT NULL;
