-- Media size on event_media (SCRUM-1066, queue task 20): the dashboard measures each upload in the browser
-- and sends width, height and (for a clip) duration_ms, so the app can choose a card's fit before the bytes land.
-- Additive: three nullable columns and their shape checks; every existing row is NULL and passes.
-- Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_media"
  ADD COLUMN "width" INTEGER,
  ADD COLUMN "height" INTEGER,
  ADD COLUMN "duration_ms" INTEGER;

-- A size is both sides or none, and each side is positive. COALESCE, because `100 > 0 AND NULL > 0` is NULL
-- and a CHECK that evaluates to NULL passes: a width without a height would get through.
ALTER TABLE "event_media" ADD CONSTRAINT "event_media_size_both"
  CHECK (("width" IS NULL AND "height" IS NULL) OR (COALESCE("width", 0) > 0 AND COALESCE("height", 0) > 0));
-- A length is positive and only on a clip. The 15 s ceiling is the app's (`MEDIA.MAX_CLIP_MS`).
ALTER TABLE "event_media" ADD CONSTRAINT "event_media_duration_on_video"
  CHECK ("duration_ms" IS NULL OR ("duration_ms" > 0 AND "type" = 'video'));

COMMIT;
