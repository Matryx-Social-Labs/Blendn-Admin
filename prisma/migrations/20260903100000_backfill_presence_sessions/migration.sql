-- History, so the readers can move.
--
-- `presence_sessions` only holds arrivals since it existed. Pointing occupancy
-- or attendance at it before this runs would report zero for every event that
-- has already happened — a cutover that silently erases the past is worse than
-- no cutover.
--
-- Safe at this size: 36 rows on staging, 9 on production, 12 in the seeded
-- world. A set-based insert rather than a script because there is no batching
-- decision to make at three dozen rows, and a migration is the thing that
-- actually runs on deploy.
--
-- Idempotent: `NOT EXISTS` means a second run inserts nothing, so this is safe
-- to replay and safe beside the partial unique on open sessions.
INSERT INTO "presence_sessions" (
  "event_id", "occurrence_id", "user_id", "kind",
  "arrived_at", "departed_at", "departed_source",
  "last_seen_at", "last_lat", "last_lng", "source",
  "created_at", "updated_at"
)
SELECT
  c."event_id",
  c."occurrence_id",
  c."user_id",
  c."kind",
  c."check_in_time",
  c."check_out_time",
  -- NULL, deliberately: we do not know how these ended.
  --
  -- The old row records *that* somebody left, never *how* — there was no
  -- `departed_source`, because with one mutable row there was nothing to
  -- attribute. Writing 'user' would claim a person pressed a button, and
  -- 'sweeper' would claim the system inferred it; both are inventions.
  --
  -- `departureQuality` therefore has to exclude unknown-source rows from its
  -- ratio rather than counting them as definite signals, or every historical
  -- occurrence would look confidently measured when it was never measured at
  -- all.
  NULL,
  -- The last thing we knew, which for a closed session is when they left.
  COALESCE(c."last_seen_at", c."check_out_time", c."check_in_time"),
  c."latitude",
  c."longitude",
  -- Everything before this migration came from the client's foreground polling;
  -- OS region monitoring has never been wired, and the Expo client refuses the
  -- background permission deliberately.
  'polling',
  c."created_at",
  NOW()
FROM "event_check_ins" c
WHERE c."check_in_time" IS NOT NULL
  -- `pending` never arrived and `cancelled` was undone by the event being
  -- cancelled. Neither is a visit, and turning them into sessions would invent
  -- attendance that did not happen.
  AND c."status" IN ('checked_in', 'checked_out')
  AND NOT EXISTS (
    SELECT 1 FROM "presence_sessions" p
    WHERE p."occurrence_id" = c."occurrence_id"
      AND p."user_id" = c."user_id"
      AND p."arrived_at" = c."check_in_time"
  );
