-- When the account last ended every dashboard session (SCRUM-603).
--
-- Settings' "End dashboard sessions" deleted NextAuth `Session` rows, and the
-- dashboard's JWT strategy never writes one, so it ended nothing while
-- reporting "no other sessions". lib/session-revocation.ts's `isRevoked` now
-- ends a session that signed in at or before this moment, exactly as it does
-- for `password_changed_at`.
--
-- Additive and nullable (no default): a catalogue change, no rewrite. Rolling
-- back is a NEW forward migration dropping the column; a rollback of the CODE
-- alone is safe, since older code reads no such column. Its own transaction,
-- with lock_timeout (memory: prisma-migrate-deploy-not-transactional).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN "sessions_revoked_at" TIMESTAMPTZ(6);

COMMIT;
