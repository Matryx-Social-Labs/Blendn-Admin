-- A city is compared to the catalogue through one normaliser: `cityKey` in lib/address.ts and this, pinned equal
-- by travel-catalogue.itest.ts. A padded, zero-width or "Toronto, ON" row would otherwise pass a closed city's
-- exclusion and never match its name. Whichever writer it is. Explicit whitespace, no locale-dependent class.
-- Migration SQL only: a `db push` database has no trigger. One table per file, so no lock spans two.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION clean_city_text(value TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(
    split_part(regexp_replace(value, '[\u200B-\u200D\uFEFF]', '', 'g'), ',', 1),
    '^[\t-\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t-\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$',
    '', 'g')
$$;
CREATE FUNCTION clean_city_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."city" := clean_city_text(NEW."city");
  RETURN NEW;
END;
$$;
UPDATE "events" SET "city" = clean_city_text("city") WHERE "city" IS DISTINCT FROM clean_city_text("city");
CREATE TRIGGER "events_city_clean" BEFORE INSERT OR UPDATE OF "city" ON "events" FOR EACH ROW EXECUTE FUNCTION clean_city_column();
COMMIT;
