-- Venue candidates for the five launch cities, from Overture Maps places.
-- See README.md beside this file for why these sources, these filters, and what happens next.
--
--   duckdb < scripts/places/candidates.sql        (run from the repo root; ~1 min, reads S3 anonymously)
--
-- Writes scripts/places/out/review/city=<city>/data_0.csv for the review pass.

INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;
SET s3_region = 'us-west-2';

-- The release is pinned: a run must be reproducible, and Overture ids churn between releases.
SET VARIABLE release = '2026-09-23.1';

-- Same boxes as scripts/map-buildings/cities.json.
CREATE TABLE cities AS SELECT * FROM (VALUES
  ('bengaluru', 'Bengaluru', 77.45, 12.83, 77.78, 13.14),
  ('mumbai',    'Mumbai',    72.77, 18.89, 73.03, 19.28),
  ('delhi-ncr', 'Delhi',     76.84, 28.40, 77.35, 28.88),
  ('hyderabad', 'Hyderabad', 78.30, 17.30, 78.60, 17.56),
  ('pune',      'Pune',      73.74, 18.43, 73.98, 18.64)) t(slug, city, xmin, ymin, xmax, ymax);

CREATE TABLE raw AS
SELECT c.slug, c.city AS box_city, p.id, p.names.primary AS name, p.basic_category, p.taxonomy.primary AS cat,
       coalesce(p.taxonomy.alternates, []) AS alts, p.confidence, p.operating_status, p.brand.names.primary AS brand,
       list_filter(coalesce(p.websites, []), lambda w: NOT regexp_matches(w, '(facebook|twitter|instagram|x)\.com')) AS sites,
       p.addresses[1].freeform AS address, p.addresses[1].locality AS locality,
       ST_X(p.geometry) AS lng, ST_Y(p.geometry) AS lat
FROM read_parquet('s3://overturemaps-us-west-2/release/' || getvariable('release') || '/theme=places/type=place/*') p
JOIN cities c ON p.bbox.xmin BETWEEN c.xmin AND c.xmax AND p.bbox.ymin BETWEEN c.ymin AND c.ymax
WHERE p.bbox.xmin BETWEEN 72.77 AND 78.60 AND p.bbox.ymin BETWEEN 12.83 AND 28.88
  -- Almost every place has no status; only an explicit closure is a reason to drop one.
  AND coalesce(p.operating_status, 'open') = 'open'
  AND p.names.primary IS NOT NULL;

-- Places people go to meet: nightlife, cafés and coffee chains, coworking, and restaurants that are also bars.
CREATE TABLE grouped AS
SELECT *, CASE
    WHEN basic_category IN ('bar', 'lounge', 'brewery', 'dance_club', 'nightlife_venue', 'winery')
      OR cat IN ('gastropub', 'beer_garden', 'music_venue', 'comedy_club', 'karaoke_venue', 'social_club') THEN 'nightlife'
    WHEN cat IN ('cafe', 'coffee_shop', 'coffee_roastery') THEN 'cafe'
    WHEN cat = 'coworking_space' THEN 'coworking'
    WHEN basic_category = 'restaurant' THEN 'restaurant'
  END AS grp
FROM raw;

-- Confidence floors were set by reading samples: below ~0.6 the bar categories are mostly local
-- "X Bar and Restaurant" liquor bars and mis-pinned rows. Restaurants need a drinks signal.
CREATE TABLE kept AS
SELECT * FROM grouped WHERE grp IS NOT NULL AND (
     (grp = 'nightlife' AND confidence >= 0.6)
  OR (grp = 'cafe'      AND confidence >= 0.6 AND (brand IS NOT NULL OR len(sites) > 0 OR confidence >= 0.8))
  OR (grp = 'coworking' AND confidence >= 0.6)
  OR (grp = 'restaurant' AND confidence >= 0.7 AND (
        list_has_any(alts, ['bar', 'pub', 'lounge', 'cocktail_bar', 'brewery', 'wine_bar', 'beer_bar', 'sports_bar', 'gastropub'])
        OR regexp_matches(lower(name), '(^|\s)(bar|pub|brew\w*|lounge|bistro|taproom|social|tavern)(\s|$)'))))
  -- A place named after another city is a mis-pin ("Tantra Nightclub Kolkata" sat in Bengaluru).
  AND NOT regexp_matches(lower(name), 'kolkata|chennai|goa\b|jaipur|chandigarh|ahmedabad');

-- One row per place: Overture can still hold the same name twice a few metres apart.
CREATE TABLE deduped AS
SELECT * EXCLUDE (rn) FROM (
  SELECT k.*, row_number() OVER (
           PARTITION BY slug, lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')), round(lat, 3), round(lng, 3)
           ORDER BY confidence DESC) AS rn
  FROM kept k)
WHERE rn = 1;

COPY (
  SELECT slug,
         -- The city a person would name. NCR and the Mumbai box hold separate cities.
         CASE
           WHEN slug = 'delhi-ncr' AND regexp_matches(lower(coalesce(locality, address, '')), 'gurugram|gurgaon') THEN 'Gurugram'
           WHEN slug = 'delhi-ncr' AND regexp_matches(lower(coalesce(locality, address, '')), 'noida') THEN 'Noida'
           WHEN slug = 'delhi-ncr' AND regexp_matches(lower(coalesce(locality, address, '')), 'ghaziabad') THEN 'Ghaziabad'
           WHEN slug = 'delhi-ncr' AND regexp_matches(lower(coalesce(locality, address, '')), 'faridabad') THEN 'Faridabad'
           WHEN slug = 'mumbai' AND regexp_matches(lower(coalesce(locality, address, '')), 'navi mumbai') THEN 'Navi Mumbai'
           WHEN slug = 'mumbai' AND regexp_matches(lower(coalesce(locality, address, '')), '\bthane\b') THEN 'Thane'
           ELSE box_city
         END AS city,
         name,
         -- Suggested Blendn venue type; the review may change it.
         CASE
           WHEN grp = 'cafe' THEN 'cafe'
           WHEN grp = 'coworking' THEN 'coworking'
           WHEN grp = 'restaurant' THEN 'restaurant'
           WHEN cat = 'lounge' THEN 'lounge_rooftop'
           WHEN cat IN ('brewery', 'winery') THEN 'brewery'
           WHEN cat IN ('dance_club', 'nightlife_venue', 'social_club') THEN 'nightclub'
           WHEN cat IN ('music_venue', 'karaoke_venue', 'comedy_club') THEN 'live_music_venue'
           ELSE 'pub_bar'
         END AS type,
         grp, cat, brand, sites[1] AS website, address, round(confidence, 2) AS confidence,
         round(lat, 6) AS lat, round(lng, 6) AS lng,
         'overture:' || getvariable('release') AS source,
         id AS source_id
  FROM deduped
  ORDER BY slug, grp, confidence DESC
) TO 'scripts/places/out/review' (FORMAT csv, HEADER, PARTITION_BY (slug), OVERWRITE_OR_IGNORE);

SELECT slug, grp, count(*) AS n FROM deduped GROUP BY ALL ORDER BY slug, n DESC;
