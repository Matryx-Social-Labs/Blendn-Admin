-- Why a phone's session was ended by a password reset or a sign-out-everywhere,
-- so the refresh that finds the token revoked can say so (Flow 15). Nullable and
-- unindexed: it is read by primary key, on a refused refresh, and a revoked row
-- from before this column has no reason, which reads as the plain 401 it was.
-- A nullable ADD COLUMN with no default rewrites nothing.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "mobile_refresh_tokens" ADD COLUMN "revoked_reason" TEXT;

COMMIT;
