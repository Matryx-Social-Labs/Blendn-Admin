-- Since when an account is known to be under 18 (SCRUM-1169, D-026): set by scripts/under-18-accounts.ts --apply,
-- read by participationDenial (lib/age.ts). Expand only: nullable, no default, catalog only, no rewrite.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "under_18_since" TIMESTAMPTZ(6);
COMMIT;
