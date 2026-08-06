-- Geofencing for GPS check-in.
--
-- `check_in_radius` was one number doing three jobs — the venue's actual size,
-- deliberate tolerance for the queue outside, and slack for bad GPS. That is
-- why it cannot be set correctly for both a 20m cafe and a 200m stadium: any
-- value big enough to absorb indoor GPS error is big enough to swallow the
-- venue next door.
--
-- `geofence` separates them. Extent is traced (circle or polygon), buffer is
-- the organiser's deliberate tolerance, and the accuracy allowance is applied
-- per check-in from what the device itself reports. Tight geometry plus
-- adaptive tolerance gives fewer false rejections AND less overlap, instead of
-- trading one against the other.
--
-- Nullable and additive: null falls back to the old columns, so nothing needs
-- backfilling and every existing event keeps working.

ALTER TABLE "events" ADD COLUMN "geofence" JSONB;
