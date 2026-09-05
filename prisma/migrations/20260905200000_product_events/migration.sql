-- The behavioural signals that have no table behind them.
--
-- Everything the loop-closure funnel counts is already a row somewhere and is
-- queried directly. What has no table is browsing, searching, viewing and
-- opening the app -- and the last of those is why this exists, because
-- `activeThisWeek` is distinct refresh-token holders and is documented in-repo
-- as a proxy.
--
-- `dedupe_key` is unique and that is the whole design. It replaces the outbox
-- the rebuild plan specified: an outbox makes an EXTERNAL side effect
-- exactly-once with respect to a STATE CHANGE, and an app-open is neither. The
-- requirement that actually exists is that a retry, a double-tap or two
-- replicas do not count one person twice, and a unique index enforces that in
-- the database rather than in a worker nobody is watching.
CREATE TABLE IF NOT EXISTS "product_events" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "user_id"     TEXT,
  "name"        TEXT NOT NULL,
  "entity_kind" TEXT,
  "entity_id"   UUID,
  "props"       JSONB,
  "dedupe_key"  TEXT NOT NULL,
  CONSTRAINT "product_events_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_events_dedupe_key_key"
  ON "product_events" ("dedupe_key");

-- DAU, WAU and MAU: one name over a date range.
CREATE INDEX IF NOT EXISTS "product_events_name_occurred_at_idx"
  ON "product_events" ("name", "occurred_at");

-- One person's activity, for cohorts and retention curves. Also the path the
-- CASCADE above takes on erasure; an unindexed foreign key makes that a
-- sequential scan, which is what fk-indexes.itest.ts exists to catch.
CREATE INDEX IF NOT EXISTS "product_events_user_id_occurred_at_idx"
  ON "product_events" ("user_id", "occurred_at");
