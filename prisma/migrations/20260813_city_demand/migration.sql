-- Where people opened the app and found nothing.
--
-- One row per person per city, not per open: the question is "how many people
-- are waiting in Saarbrücken", and a log of opens cannot answer it — one
-- enthusiast reopening fifty times would outrank fifty separate people. The
-- unique constraint is the measurement.
--
-- No coordinates stored. City and country are what a launch decision needs, and
-- a per-open GPS trail would be a far larger promise about privacy than this
-- feature is worth.

CREATE TABLE "city_demand" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "city_key" TEXT NOT NULL,
    "country" TEXT,
    "first_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opens" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "city_demand_pkey" PRIMARY KEY ("id")
);

-- The measurement: one row per person per city.
CREATE UNIQUE INDEX "city_demand_user_id_city_key_key" ON "city_demand"("user_id", "city_key");

-- "where are people waiting" — the only query this table exists for.
CREATE INDEX "city_demand_city_key_idx" ON "city_demand"("city_key");

-- Someone who leaves takes their signal with them.
ALTER TABLE "city_demand" ADD CONSTRAINT "city_demand_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
