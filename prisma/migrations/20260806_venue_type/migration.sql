-- What kind of place a venue is, and where check-in counts there.
--
-- Nothing distinguished a restaurant from a stadium. That matters for every
-- question the product asks about a venue: what a sensible geofence looks like,
-- what capacity is plausible, and what an organiser is searching for.
--
-- `geofence` on the venue is the other half. A check-in area is a property of
-- the PLACE, not of each event held there — it was being re-drawn per event for
-- a building that never moves. Events inherit it and may override per event,
-- because a rooftop event at a three-floor venue is a real case.
--
-- Both nullable and additive. Venues predating this keep working, and an admin
-- adding a venue in a hurry is not blocked on classifying it.

CREATE TYPE "venue_type" AS ENUM (
  'restaurant', 'pub_bar', 'brewery', 'cafe', 'lounge_rooftop',
  'nightclub', 'live_music_venue',
  'banquet_hall', 'convention_centre', 'conference_centre', 'hotel', 'resort', 'farmhouse',
  'stadium', 'sports_complex', 'gym_fitness_studio',
  'theatre', 'cinema', 'art_gallery', 'museum', 'amphitheatre',
  'community_hall', 'coworking', 'campus', 'school', 'library', 'religious_venue',
  'park_ground', 'beach_waterfront', 'terrace',
  'studio', 'warehouse', 'retail_mall', 'private_residence', 'other'
);

ALTER TABLE "venues" ADD COLUMN "venue_type" "venue_type";
ALTER TABLE "venues" ADD COLUMN "geofence" JSONB;
