-- A clip's copies on event_media (SCRUM-1106, queue task 30): [{url, width, height, bytes}], smallest first,
-- made by the media worker. Additive: one nullable column and its shape check; every existing row is NULL and passes.
-- Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_media" ADD COLUMN "renditions" JSONB;

-- Only on a video, and an array. jsonb_typeof(NULL) is NULL, so NULL is spelled out.
ALTER TABLE "event_media" ADD CONSTRAINT "event_media_renditions_on_video"
  CHECK ("renditions" IS NULL OR ("type" = 'video' AND jsonb_typeof("renditions") = 'array'));

COMMIT;
