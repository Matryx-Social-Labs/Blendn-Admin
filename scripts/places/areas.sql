-- Which neighbourhood each venue is in, from Overture's own division polygons.
-- See scripts/backfill-venue-areas.ts, which writes the points file this reads
-- and applies the file this writes.
--
--   duckdb < scripts/places/areas.sql        (from the repo root; reads S3 anonymously)
--
-- Reads  scripts/places/out/venue-points.csv   id, lat, lng
-- Writes scripts/places/out/venue-areas.csv    id, area
--
-- The rule, and why it is this one. Overture's `locality` division is the only layer that
-- covers the launch cities without overlapping itself once three things are left out:
--   - a `... Ward` (a municipal ward: nobody says "I'm in K Kamaraj Ward"),
--   - a `... City Corporation` (Bengaluru's five zones),
--   - anything city-sized (the city's own polygon): over 0.003 square degrees, about 36 km2.
-- A point takes the smallest polygon left that holds it. A point in none gets NO row: its area
-- stays null on the venue. Nothing is guessed, and nothing is borrowed from the address text.
-- The spelling is Overture's ("Kormangala West"); fixing a name is a decision for whoever owns
-- the list, not for this query.

INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
SET s3_region = 'us-west-2';

-- The same pinned release as candidates.sql.
SET VARIABLE release = '2026-09-23.1';

CREATE TABLE points AS
SELECT id, lat::DOUBLE AS lat, lng::DOUBLE AS lng
FROM read_csv('scripts/places/out/venue-points.csv', header = true, all_varchar = true);

CREATE TABLE extent AS
SELECT min(lng) AS xmin, max(lng) AS xmax, min(lat) AS ymin, max(lat) AS ymax FROM points;

CREATE TABLE localities AS
SELECT d.names.primary AS name, d.geometry, ST_Area(d.geometry) AS size
FROM read_parquet('s3://overturemaps-us-west-2/release/' || getvariable('release') || '/theme=divisions/type=division_area/*') d, extent e
WHERE d.country = 'IN' AND d.subtype = 'locality'
  AND d.bbox.xmin <= e.xmax AND d.bbox.xmax >= e.xmin AND d.bbox.ymin <= e.ymax AND d.bbox.ymax >= e.ymin
  AND d.names.primary IS NOT NULL
  AND NOT regexp_matches(d.names.primary, '(Ward|City Corporation)$')
  AND ST_Area(d.geometry) <= 0.003;

COPY (
  SELECT p.id, arg_min(l.name, l.size) AS area
  FROM points p JOIN localities l ON ST_Contains(l.geometry, ST_Point(p.lng, p.lat))
  GROUP BY p.id
  ORDER BY p.id
) TO 'scripts/places/out/venue-areas.csv' (FORMAT csv, HEADER);

SELECT count(*) AS venues, (SELECT count(*) FROM read_csv('scripts/places/out/venue-areas.csv')) AS with_an_area FROM points;
