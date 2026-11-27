-- A person report's evidence: the reported person's last lines in the room or
-- conversation it was filed from, copied at report time. Nullable.
ALTER TABLE "user_reports" ADD COLUMN "excerpt" TEXT;
