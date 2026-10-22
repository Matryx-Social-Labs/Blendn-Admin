-- When an account's password last changed (step 18 security review, M6).
--
-- A password reset revoked the account's phones but not its dashboard
-- sessions: the dashboard's session is a JWT with nothing stored to delete,
-- so a session somebody stole kept working after the owner reset the password
-- to lock them out. lib/auth.ts's jwt callback now refuses a session that
-- signed in before this moment. Set by the reset link and by Settings.
--
-- Additive and nullable (no default): a catalogue change, no rewrite. Rolling
-- back is a NEW forward migration dropping the column; a rollback of the CODE
-- alone is safe, since older code reads no such column. Its own transaction,
-- with lock_timeout, as every migration since step 17.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" ADD COLUMN "password_changed_at" TIMESTAMPTZ(6);

COMMIT;
