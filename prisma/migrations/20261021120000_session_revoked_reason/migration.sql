-- Why a phone's session was ended by a password reset or a sign-out-everywhere,
-- so the refresh that finds the token revoked can say so (Flow 15). Nullable and
-- unindexed: it is read by primary key, on a refused refresh, and a revoked row
-- from before this column has no reason, which reads as the plain 401 it was.
-- A nullable ADD COLUMN with no default rewrites nothing, and the CHECK passes
-- every existing row because they are all NULL.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "mobile_refresh_tokens" ADD COLUMN IF NOT EXISTS "revoked_reason" TEXT;

-- The two writers are `endPhoneSessions` callers (lib/session-end.ts); a third
-- reason is a code change, a client string and a migration, not a typo.
ALTER TABLE "mobile_refresh_tokens"
  ADD CONSTRAINT "mobile_refresh_tokens_revoked_reason_known"
  CHECK ("revoked_reason" IN ('password_reset', 'signout_all'));

COMMIT;
