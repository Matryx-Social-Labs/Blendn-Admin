-- SCRUM-1026, the Lobby (was the Board): plain post types, one photo per post with a moderation
-- state, the host's pinned post, and per-event alert switches.
--
-- Every CHECK below exists only here: `db push` creates none (CLAUDE.md lists them).
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
BEGIN;

CREATE TYPE "board_post_sub_kind" AS ENUM ('ride', 'spots', 'ticket', 'buddy');
CREATE TYPE "board_photo_status" AS ENUM ('pending', 'approved', 'rejected');

ALTER TABLE "board_posts"
  ADD COLUMN "sub_kind" "board_post_sub_kind",
  ADD COLUMN "photo_url" TEXT,
  ADD COLUMN "photo_status" "board_photo_status",
  ADD COLUMN "photo_alt" TEXT,
  ADD COLUMN "photo_checked_at" TIMESTAMPTZ(6);

-- An offer is of a ride, spots or a spare ticket; a search is for a ride, somebody to go with or a
-- ticket; a chat post is about neither. Null is "did not say" (every post from before this).
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_sub_kind_fits" CHECK (
  "sub_kind" IS NULL
  OR ("kind" = 'offer' AND "sub_kind" IN ('ride', 'spots', 'ticket'))
  OR ("kind" = 'seeking' AND "sub_kind" IN ('ride', 'buddy', 'ticket'))
);
-- A photo always has a moderation state, and a state always has a photo.
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_photo_has_status"
  CHECK (("photo_url" IS NULL) = ("photo_status" IS NULL));
-- Alt text describes a photo, so it needs one; 200 characters at most.
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_photo_alt_fits"
  CHECK ("photo_alt" IS NULL OR ("photo_url" IS NOT NULL AND char_length("photo_alt") <= 200));
-- A decided photo has the time it was decided (a rejection's 180-day hold counts from it), and only a decided one.
ALTER TABLE "board_posts" ADD CONSTRAINT "board_posts_photo_decided_at"
  CHECK (COALESCE("photo_status" IN ('approved', 'rejected'), false) = ("photo_checked_at" IS NOT NULL));

CREATE INDEX "board_posts_photo_status_created_at_idx" ON "board_posts"("photo_status", "created_at");

CREATE TABLE "board_host_posts" (
  "id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "written_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "board_host_posts_pkey" PRIMARY KEY ("id"),
  -- The note is short: doors, the entrance, what to bring.
  CONSTRAINT "board_host_posts_body_length" CHECK (char_length("body") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX "board_host_posts_event_id_key" ON "board_host_posts"("event_id");
CREATE INDEX "board_host_posts_written_by_idx" ON "board_host_posts"("written_by");
ALTER TABLE "board_host_posts" ADD CONSTRAINT "board_host_posts_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_host_posts" ADD CONSTRAINT "board_host_posts_written_by_fkey"
  FOREIGN KEY ("written_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "board_alert_preferences" (
  "user_id" TEXT NOT NULL,
  "event_id" UUID NOT NULL,
  "offers_match" BOOLEAN NOT NULL DEFAULT false,
  "replies" BOOLEAN NOT NULL DEFAULT false,
  "host_posts" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "board_alert_preferences_pkey" PRIMARY KEY ("user_id", "event_id")
);
CREATE INDEX "board_alert_preferences_event_id_idx" ON "board_alert_preferences"("event_id");
ALTER TABLE "board_alert_preferences" ADD CONSTRAINT "board_alert_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_alert_preferences" ADD CONSTRAINT "board_alert_preferences_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
