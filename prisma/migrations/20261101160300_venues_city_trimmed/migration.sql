-- A city is compared to the catalogue through one normaliser: `cityKey` in lib/address.ts and this, pinned equal
-- by travel-catalogue.itest.ts. A padded, zero-width or "Toronto, ON" row would otherwise pass a closed city's
-- exclusion and never match its name. Whichever writer it is. Explicit whitespace, no locale-dependent class.
-- Migration SQL only: a `db push` database has no trigger. One table per file, so no lock spans two.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "venues" SET "city" = clean_city_text("city") WHERE "city" IS DISTINCT FROM clean_city_text("city");
CREATE TRIGGER "venues_city_clean" BEFORE INSERT OR UPDATE OF "city" ON "venues" FOR EACH ROW EXECUTE FUNCTION clean_city_column();
COMMIT;
