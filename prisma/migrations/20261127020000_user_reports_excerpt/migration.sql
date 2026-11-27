-- A person report's evidence: the reported person's last lines in the room or
-- conversation it was filed from, copied at report time (lib/report-evidence.ts).
--
-- Additive: one nullable column, no rewrite. Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "user_reports" ADD COLUMN "excerpt" TEXT;

COMMIT;
