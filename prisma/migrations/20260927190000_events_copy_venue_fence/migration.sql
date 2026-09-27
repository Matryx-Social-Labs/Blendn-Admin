-- Owner's ruling 3 (2026-09-27): an event COPIES its venue's check-in area.
--
-- Check-in (`resolveFence`) falls back to the venue's area LIVE for an event
-- without one of its own. With organisers now editing the unclaimed venues
-- they add (SCRUM-352), that would let one organisation move another's
-- check-in area. The save routes copy the area from now on
-- (`venueFenceToCopy`); this copies it onto the events already linked.
-- JSON `null` is treated as no area, like SQL NULL (see geofence-clear.itest.ts).
UPDATE "events" AS e
   SET "geofence" = v."geofence"
  FROM "venues" AS v
 WHERE e."venue_id" = v."id"
   AND (e."geofence" IS NULL OR e."geofence" = 'null'::jsonb)
   AND v."geofence" IS NOT NULL
   AND v."geofence" <> 'null'::jsonb
   AND e."deleted_at" IS NULL;
