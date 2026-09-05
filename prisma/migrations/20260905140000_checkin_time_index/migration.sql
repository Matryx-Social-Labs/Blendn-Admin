-- `check_in_time` on its own, for the window scans that are not per-event.
--
-- Every existing index on this column is composite and starts with `event_id`,
-- so a query asking "who checked in anywhere in the last 7 days" — the health
-- endpoint's interest-coverage probe, which is POLLED — could only sequential
-- scan. `EXPLAIN` confirmed it before this existed.
--
-- Partial on `check_in_time IS NOT NULL`: a row without one has not arrived,
-- and every caller of this shape is asking about arrivals.
CREATE INDEX IF NOT EXISTS "event_check_ins_check_in_time_idx"
  ON "event_check_ins"("check_in_time")
  WHERE "check_in_time" IS NOT NULL;
