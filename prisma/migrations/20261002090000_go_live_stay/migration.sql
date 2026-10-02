-- Go Live (step 4, plan v2 §14): "stay", and the index the expiry sweep reads.
--
-- `stay_until`: the furthest an in-fence ping may carry a "stay" window —
-- four hours from the first time "stay" was chosen at the venue that day, or
-- the venue's reset. Kept for the day once set (lib/go-live.ts).
-- `stay`: whether the Go Live is "stay" now; a fixed window keeps `stay_until`
-- but is never extended.
-- Both additive: null / false for every event check-in, and nothing reads them
-- until the Go Live route ships.
--
-- `event_check_ins_status_expires_at_idx`: the expiry sweep asks "checked in,
-- window ended, oldest end first" every 30 s. The partial index on
-- `expires_at` alone (20261001220000_venue_days) walks every Go Live ever
-- made from the oldest and filters on status; this one starts at the open
-- windows. CREATE INDEX (not CONCURRENTLY): `migrate deploy` runs each file in
-- a transaction, and the table is small enough today for the brief lock.
--
-- Rolling back: a NEW forward migration with
--   DROP INDEX "event_check_ins_status_expires_at_idx";
--   ALTER TABLE "event_check_ins" DROP COLUMN "stay", DROP COLUMN "stay_until";
-- never SQL run by hand against staging or production.
ALTER TABLE "event_check_ins" ADD COLUMN "stay_until" TIMESTAMPTZ(6);
ALTER TABLE "event_check_ins" ADD COLUMN "stay" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "event_check_ins_status_expires_at_idx" ON "event_check_ins" ("status", "expires_at");
