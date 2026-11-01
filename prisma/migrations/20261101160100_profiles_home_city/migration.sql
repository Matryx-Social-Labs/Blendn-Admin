-- Its own file: M1 holds a lock on "User", and writers take "User" and `profiles` in both orders, so
-- one transaction over the two could deadlock with a live write and block every later deploy.
-- Nullable with no default, and the FK in one statement: Postgres does not scan for a new all-NULL column.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "profiles" ADD COLUMN "home_city_id" UUID CONSTRAINT "profiles_home_city_id_fkey" REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "profiles_home_city_id_idx" ON "profiles"("home_city_id");
COMMIT;
