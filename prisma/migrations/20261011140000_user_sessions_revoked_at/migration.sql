-- When the account last ended its sessions (SCRUM-603), one stamp per system.
--
-- Settings' "End dashboard sessions" deleted NextAuth `Session` rows, and the
-- dashboard's JWT strategy never writes one, so it ended nothing while
-- reporting "no other sessions". lib/session-revocation.ts's `isRevoked` now
-- ends a dashboard session that signed in at or before `sessions_revoked_at`,
-- exactly as it does for `password_changed_at`.
--
-- Ending the phones revoked their refresh tokens and left every access token
-- live for its 15 minutes, and a socket opened with one for good. Mobile auth
-- (lib/account-blocklist.ts, the socket handshake) now refuses an access
-- token issued at or before `mobile_sessions_revoked_at`.
--
-- Additive and nullable (no default): a catalogue change, no rewrite. Rolling
-- back is a NEW forward migration dropping the columns; a rollback of the CODE
-- alone is safe, since older code reads no such column. Its own transaction,
-- with lock_timeout (memory: prisma-migrate-deploy-not-transactional).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN "sessions_revoked_at" TIMESTAMPTZ(6);
ALTER TABLE "User" ADD COLUMN "mobile_sessions_revoked_at" TIMESTAMPTZ(6);

COMMIT;
