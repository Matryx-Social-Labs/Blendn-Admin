-- Where a seeded venue came from (scripts/places, the venue-seeding pipeline).
--
-- A venue imported from an open dataset records its source and that source's
-- record id. The monthly refresh needs them to tell a known place from a new
-- one and to find the venues a source has since marked closed. A removal
-- request needs them too. Typed-in and claimed venues leave all three null.
--
-- `source` names the dataset and its release (e.g. "overture:2026-09-23.1").
-- The record id is unique across all rows (Overture's ids are global), so a
-- re-run of the same file can never insert the same place twice; soft-deleted
-- venues keep theirs, so a place removed on request is not re-imported.
-- `source_seen_at` is when an import last listed the place.
--
-- Additive and nullable: a catalogue change, no rewrite. The unique index is
-- partial, so it builds over the existing rows (all null) without
-- scanning anything of note. Its own transaction, with lock_timeout (memory:
-- prisma-migrate-deploy-not-transactional).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "venues" ADD COLUMN "source" TEXT;
ALTER TABLE "venues" ADD COLUMN "source_record_id" TEXT;
ALTER TABLE "venues" ADD COLUMN "source_seen_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "venues_one_per_source_record" ON "venues" ("source_record_id") WHERE "source_record_id" IS NOT NULL;

COMMIT;
