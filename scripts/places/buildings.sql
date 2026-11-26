-- The Overture buildings near each seeded venue, for its check-in area (SCRUM-1150).
-- See scripts/backfill-venue-fences.ts, which writes the venues file this reads and picks from the file this writes.
--
--   FENCES_DIR=<dir outside the repo> CITY=bengaluru duckdb < scripts/places/buildings.sql
--
-- Reads  $FENCES_DIR/venues.ndjson                 id, lat, lng, city (and more this ignores)
-- Writes $FENCES_DIR/candidates-$CITY.ndjson        venue, building, dataset, cls, geometry, release
--
-- This only pre-filters: every building within about 50 m of a venue's pin. Which one becomes the fence is
-- `fenceFromCandidates` in the script, which is `pickBuilding`'s rule (lib/outline.ts), so the two cannot disagree.
-- One city per run: the box read from S3 is that city's venues, so a run reads one city's buildings, not a country's.

.bail on
INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
SET s3_region = 'us-west-2';
SET threads = 2;
SET memory_limit = '2GB';

-- The release the fences come from. 2026-11-18.0, not the home-map tiles' 2026-09-23.1: Overture keeps only its
-- last two releases, and that one is gone (SCRUM-1434 rebuilds the tiles). Written into every row, then into the
-- fences and rollback files, so a fence's release is on record without a column or a Json key.
SET VARIABLE release = coalesce(nullif(getenv('OVERTURE_RELEASE'), ''), '2026-11-18.0');
SET VARIABLE dir = getenv('FENCES_DIR');
SET VARIABLE city = getenv('CITY');

CREATE TABLE points AS
SELECT id, lat, lng
FROM read_json(getvariable('dir') || '/venues.ndjson', format = 'newline_delimited',
               columns = {id: 'VARCHAR', lat: 'DOUBLE', lng: 'DOUBLE', city: 'VARCHAR'})
WHERE city = getvariable('city');

-- A typo'd or unset CITY reads nothing and says so; "elsewhere" (uncatalogued cities) is scattered over the world and
-- would read a continent's buildings, so it is refused too.
SELECT CASE WHEN count(*) = 0 THEN error('no venues for CITY=' || coalesce(getvariable('city'), '(unset)'))
            WHEN max(lng) - min(lng) > 1.5 OR max(lat) - min(lat) > 1.5 THEN error('the venues of CITY=' || getvariable('city') || ' span more than 1.5 degrees: not one city')
       END AS checked
FROM points;

-- The city's box, from its own venues, with room for a building whose edge is 25 m off a pin at the box's edge.
SET VARIABLE xmin = (SELECT min(lng) - 0.001 FROM points);
SET VARIABLE xmax = (SELECT max(lng) + 0.001 FROM points);
SET VARIABLE ymin = (SELECT min(lat) - 0.001 FROM points);
SET VARIABLE ymax = (SELECT max(lat) + 0.001 FROM points);

CREATE TABLE buildings AS
SELECT id, sources[1].dataset AS dataset, class AS cls, geometry
FROM read_parquet('s3://overturemaps-us-west-2/release/' || getvariable('release') || '/theme=buildings/type=building/*',
                  hive_partitioning = 1)
WHERE bbox.xmin < getvariable('xmax') AND bbox.xmax > getvariable('xmin')
  AND bbox.ymin < getvariable('ymax') AND bbox.ymax > getvariable('ymin')
  AND NOT coalesce(is_underground, false);

-- 0.0005 degrees is 55 m north-south and 40 m east-west at Toronto: more than the 25 m the pick allows.
COPY (
  SELECT p.id AS venue, b.id AS building, b.dataset, b.cls, ST_AsGeoJSON(b.geometry) AS geometry,
         getvariable('release') AS release
  FROM points p JOIN buildings b ON ST_DWithin(b.geometry, ST_Point(p.lng, p.lat), 0.0005)
  ORDER BY p.id, b.id
) TO (getvariable('dir') || '/candidates-' || getvariable('city') || '.ndjson') (FORMAT json);

SELECT getvariable('city') AS city, getvariable('release') AS release,
       (SELECT count(*) FROM points) AS venues, (SELECT count(*) FROM buildings) AS buildings_in_box;
