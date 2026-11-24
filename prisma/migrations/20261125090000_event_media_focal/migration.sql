-- Focal point on event_media (SCRUM-1106, queue task 30): where the subject is, 0–1 of the picture from its
-- left and top, picked in the dashboard. The app crops a clip (and a still within fit rule B's ±15%) around it.
-- Additive: two nullable columns and their shape check; every existing row is NULL and passes.
-- Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_media"
  ADD COLUMN "focal_x" DOUBLE PRECISION,
  ADD COLUMN "focal_y" DOUBLE PRECISION;

-- Both or neither, each inside the picture. COALESCE to -1, because `0.5 BETWEEN 0 AND 1 AND NULL BETWEEN 0 AND 1`
-- is NULL and a CHECK that evaluates to NULL passes: half a point would get through. 'NaN' is above every number
-- in Postgres, so BETWEEN refuses it too.
ALTER TABLE "event_media" ADD CONSTRAINT "event_media_focal_both"
  CHECK (("focal_x" IS NULL AND "focal_y" IS NULL)
    OR (COALESCE("focal_x", -1) BETWEEN 0 AND 1 AND COALESCE("focal_y", -1) BETWEEN 0 AND 1));

COMMIT;
