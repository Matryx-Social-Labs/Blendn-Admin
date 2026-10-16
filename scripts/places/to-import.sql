-- Reviewed candidates → one import file per city for scripts/import-venues.ts.
--
--   duckdb < scripts/places/to-import.sql        (from the repo root, after the review pass)
--
-- Reads out/review/slug=*/data_0.csv and out/decisions/*.csv; writes out/import/<slug>.csv.
-- A candidate with no decision row is left out, and counted below, so a missed chunk is visible.

CREATE TABLE candidates AS
SELECT * FROM read_csv('scripts/places/out/review/slug=*/data_0.csv', header = true, all_varchar = true, hive_partitioning = true);

CREATE TABLE decisions AS
SELECT * FROM read_csv('scripts/places/out/decisions/*.csv', header = true, all_varchar = true);

CREATE TABLE kept AS
SELECT c.slug, c.name, c.address, c.lat, c.lng, d.type, c.city, c.source, c.source_id, d.sports = '1' AS sports
FROM candidates c JOIN decisions d USING (source_id)
WHERE d.keep = '1';

SELECT slug, count(*) AS kept, count(*) FILTER (WHERE sports) AS sports_bars FROM kept GROUP BY slug ORDER BY slug;
SELECT count(*) AS candidates_without_a_decision FROM candidates WHERE source_id NOT IN (SELECT source_id FROM decisions);
SELECT slug, type, count(*) AS n FROM kept GROUP BY ALL ORDER BY slug, n DESC;

COPY (SELECT slug, name, address, lat, lng, type, city, source, source_id FROM kept ORDER BY slug, type, name)
TO 'scripts/places/out/import' (FORMAT csv, HEADER, PARTITION_BY (slug), OVERWRITE_OR_IGNORE);

-- The sports bars, for match nights (docs: scripts/places/README.md).
COPY (SELECT slug, name, city, lat, lng, source_id FROM kept WHERE sports ORDER BY slug, name)
TO 'scripts/places/out/sports-bars.csv' (FORMAT csv, HEADER);
