-- A city is compared to the catalogue trimmed, and a padded row would pass a closed city's exclusion and
-- never match its name. Nothing can write one now, whichever writer it is. JS trim's whitespace, not just spaces.
-- Migration SQL only: a `db push` database has no trigger. One table per file, so no lock spans two.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "venues" SET "city" = trim_city_text("city") WHERE "city" IS DISTINCT FROM trim_city_text("city");
CREATE TRIGGER "venues_city_trimmed" BEFORE INSERT OR UPDATE OF "city" ON "venues" FOR EACH ROW EXECUTE FUNCTION trim_city_column();
COMMIT;
