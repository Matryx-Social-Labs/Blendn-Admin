-- Travel mode, phase 1 (SCRUM-709): the countries and cities Blendn serves, as rows.
-- Adding a country is INSERTs here or from the dashboard: nothing in code names one.
-- `currency` is text with a CHECK, not `currency_code`: that enum holds INR alone, and a
-- new country must not need a schema change. Wrapped: `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "launch_state" AS ENUM ('live', 'preview', 'hidden');

CREATE TABLE "markets" (
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "locale" TEXT NOT NULL,
  "launch_state" "launch_state" NOT NULL DEFAULT 'hidden',
  "sort" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "markets_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "markets_code_shape" CHECK ("code" ~ '^[A-Z]{2}$'),
  CONSTRAINT "markets_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$')
);

CREATE TABLE "cities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "market_code" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "match_names" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "region" TEXT,
  "timezone" TEXT NOT NULL,
  "launch_state" "launch_state" NOT NULL DEFAULT 'hidden',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "centre_lat" DOUBLE PRECISION NOT NULL,
  "centre_lon" DOUBLE PRECISION NOT NULL,
  "min_lat" DOUBLE PRECISION NOT NULL,
  "min_lon" DOUBLE PRECISION NOT NULL,
  "max_lat" DOUBLE PRECISION NOT NULL,
  "max_lon" DOUBLE PRECISION NOT NULL,
  "default_licensed_min_age" INTEGER,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "cities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cities_market_code_fkey" FOREIGN KEY ("market_code") REFERENCES "markets"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "cities_slug_shape" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "cities_timezone_known" CHECK ("timezone" = 'UTC' OR "timezone" ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$'),
  CONSTRAINT "cities_bounds_order" CHECK ("min_lat" < "max_lat" AND "min_lon" < "max_lon"),
  CONSTRAINT "cities_centre_in_bounds" CHECK ("centre_lat" BETWEEN "min_lat" AND "max_lat" AND "centre_lon" BETWEEN "min_lon" AND "max_lon"),
  CONSTRAINT "cities_licensed_min_age_floor" CHECK ("default_licensed_min_age" IS NULL OR "default_licensed_min_age" >= 18)
);
CREATE UNIQUE INDEX "cities_slug_key" ON "cities"("slug");
CREATE INDEX "cities_market_code_launch_state_idx" ON "cities"("market_code", "launch_state");
-- Partial, so migration SQL only: one default city per market.
CREATE UNIQUE INDEX "cities_one_default_per_market" ON "cities"("market_code") WHERE "is_default";

CREATE TABLE "market_previewers" (
  "user_id" TEXT NOT NULL,
  "market_code" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "market_previewers_pkey" PRIMARY KEY ("user_id", "market_code"),
  CONSTRAINT "market_previewers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "market_previewers_market_code_fkey" FOREIGN KEY ("market_code") REFERENCES "markets"("code") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "market_previewers_market_code_idx" ON "market_previewers"("market_code");

-- The catalogue, in the migration so every environment has it (like the `blendn-system` user).
-- Canada is `preview`: listed as coming soon, open only to `market_previewers`.
INSERT INTO "markets" ("code", "name", "currency", "locale", "launch_state", "sort") VALUES
  ('IN', 'India', 'INR', 'en-IN', 'live', 0),
  ('CA', 'Canada', 'CAD', 'en-CA', 'preview', 1);

-- Boxes for the five map cities are scripts/map-buildings/cities.json's. Every Indian city here
-- has listed events or places on staging on 2026-11-01. A city with no rows is not listed however
-- it is set, so `live` here cannot open an empty city.
INSERT INTO "cities" ("market_code", "slug", "name", "match_names", "region", "timezone", "launch_state", "is_default", "centre_lat", "centre_lon", "min_lat", "min_lon", "max_lat", "max_lon", "default_licensed_min_age", "sort") VALUES
  ('IN', 'bengaluru', 'Bengaluru', ARRAY['bengaluru','bangalore'], 'KA', 'Asia/Kolkata', 'live', true, 12.9716, 77.5946, 12.83, 77.45, 13.14, 77.78, NULL, 0),
  ('IN', 'mumbai', 'Mumbai', ARRAY['mumbai','bombay'], 'MH', 'Asia/Kolkata', 'live', false, 19.0760, 72.8777, 18.89, 72.77, 19.28, 73.03, NULL, 1),
  ('IN', 'delhi-ncr', 'Delhi NCR', ARRAY['delhi ncr','delhi','new delhi','gurugram','gurgaon','noida','faridabad','ghaziabad'], 'DL', 'Asia/Kolkata', 'live', false, 28.6139, 77.2090, 28.40, 76.84, 28.88, 77.35, NULL, 2),
  ('IN', 'hyderabad', 'Hyderabad', ARRAY['hyderabad','secunderabad'], 'TG', 'Asia/Kolkata', 'live', false, 17.3850, 78.4867, 17.30, 78.30, 17.56, 78.60, NULL, 3),
  ('IN', 'pune', 'Pune', ARRAY['pune'], 'MH', 'Asia/Kolkata', 'live', false, 18.5204, 73.8567, 18.43, 73.74, 18.64, 73.98, NULL, 4),
  ('IN', 'thane', 'Thane', ARRAY['thane'], 'MH', 'Asia/Kolkata', 'live', false, 19.2183, 72.9781, 19.15, 72.93, 19.32, 73.10, NULL, 5),
  ('IN', 'navi-mumbai', 'Navi Mumbai', ARRAY['navi mumbai'], 'MH', 'Asia/Kolkata', 'live', false, 19.0330, 73.0297, 18.95, 72.95, 19.20, 73.12, NULL, 6),
  ('IN', 'mysuru', 'Mysuru', ARRAY['mysuru','mysore'], 'KA', 'Asia/Kolkata', 'live', false, 12.2958, 76.6394, 12.22, 76.55, 12.40, 76.75, NULL, 7),
  ('IN', 'hubballi', 'Hubballi', ARRAY['hubballi','hubli'], 'KA', 'Asia/Kolkata', 'live', false, 15.3647, 75.1240, 15.25, 75.03, 15.50, 75.25, NULL, 8),
  ('CA', 'toronto', 'Toronto', ARRAY['toronto'], 'ON', 'America/Toronto', 'preview', true, 43.6532, -79.3832, 43.58, -79.64, 43.86, -79.11, 19, 0),
  ('CA', 'vancouver', 'Vancouver', ARRAY['vancouver'], 'BC', 'America/Vancouver', 'preview', false, 49.2827, -123.1207, 49.20, -123.27, 49.32, -123.02, 19, 1);

-- Last: the lock on `profiles` is held until COMMIT, so nothing else runs under it.
-- Nullable with no default: metadata only on `profiles`. City level, set by the person, never shown to anybody else.
ALTER TABLE "profiles" ADD COLUMN "home_city_id" UUID;
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_home_city_id_fkey" FOREIGN KEY ("home_city_id") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "profiles_home_city_id_idx" ON "profiles"("home_city_id");

COMMIT;
