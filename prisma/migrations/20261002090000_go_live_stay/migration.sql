-- Go Live "stay" (step 4, plan v2 §14): how far an in-fence ping may extend a
-- venue Go Live. Null for a fixed 20/45/60-minute window and for every event
-- check-in. Additive and nullable: nothing reads it until the Go Live route
-- ships, and rolling the code back leaves a column nobody writes.
--
-- Rolling back: a NEW forward migration with
--   ALTER TABLE "event_check_ins" DROP COLUMN "stay_until";
-- never SQL run by hand against staging or production.
ALTER TABLE "event_check_ins" ADD COLUMN "stay_until" TIMESTAMPTZ(6);
