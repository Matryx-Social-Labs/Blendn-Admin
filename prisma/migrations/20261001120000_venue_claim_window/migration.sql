-- A venue owner sees a venue's events from its claim on (SCRUM-355, SCRUM-500).

-- 1. Those events are read by venue AND start: the venue page, the live count,
--    the linked-events list and every venue-owner scope filter on
--    `venue_id = ? AND start_time >= claimed_at`. The composite leads with
--    venue_id, so it still covers the foreign key the single-column index did.
DROP INDEX IF EXISTS "events_venue_id_idx";
CREATE INDEX IF NOT EXISTS "events_venue_id_start_time_idx" ON "events"("venue_id", "start_time");

-- 2. An owned venue has a claim date. Without one the claim window is
--    undefined and every reader fails closed, so the owner silently sees
--    nothing; the constraint makes that state unwritable instead.
--
--    Measured 2026-10-01: 0 such rows on staging (16 owned) and production
--    (0 owned). The backfill is defensive, for anything written between then
--    and this deploy: the approved claim's review time, or now — never
--    earlier than we can show, because an earlier date opens history.
UPDATE "venues" v
   SET "claimed_at" = COALESCE(
         (SELECT max(c."reviewed_at") FROM "venue_claims" c
           WHERE c."venue_id" = v."id" AND c."org_id" = v."owner_org_id" AND c."status" = 'approved'),
         now())
 WHERE v."owner_org_id" IS NOT NULL AND v."claimed_at" IS NULL;

ALTER TABLE "venues"
  ADD CONSTRAINT "venues_owner_needs_claimed_at"
  CHECK ("owner_org_id" IS NULL OR "claimed_at" IS NOT NULL);
