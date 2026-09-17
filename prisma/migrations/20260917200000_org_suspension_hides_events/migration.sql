-- Suspending an organisation means something (SCRUM-8): the reason lives on
-- the row for the members' banner, and a hidden event remembers what it was.
ALTER TABLE "organisations" ADD COLUMN "suspended_at" TIMESTAMPTZ(6);
ALTER TABLE "organisations" ADD COLUMN "suspension_reason" TEXT;
ALTER TABLE "events" ADD COLUMN "pre_suspension_status" "event_status";
