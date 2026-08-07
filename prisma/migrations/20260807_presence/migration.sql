-- Presence: is this person still here?
--
-- Check-in was a one-shot gate. It proved you were at the venue once and then
-- nothing revisited the claim, so anyone who left without pressing "check out"
-- stayed counted for ever.
--
-- `left_area_at` is both the state and the clock: non-null means the last ping
-- put them outside, and a ping back inside clears it. No enum to drift out of
-- sync with what the pings actually said.

ALTER TABLE "event_check_ins"
  ADD COLUMN "last_seen_at"          TIMESTAMPTZ(6),
  ADD COLUMN "left_area_at"          TIMESTAMPTZ(6),
  ADD COLUMN "departure_prompted_at" TIMESTAMPTZ(6);

-- The sweeper's query: everyone still inside, ordered by how long they have
-- been out of the fence.
CREATE INDEX "event_check_ins_status_left_area_at_idx"
  ON "event_check_ins" ("status", "left_area_at");
