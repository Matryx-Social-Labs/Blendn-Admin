-- One device, one account (SCRUM-668). Rollout: while the previous release is still serving, its upsert on (user_id, token) fails until the new one takes over, and a rollback past this migration needs the old index back. A push token is unique, not unique per
-- account: registering it moves it, so a second account on the same phone no
-- longer leaves the first account's row behind (the first account's pushes were
-- ringing the second person's phone).
--
-- Existing duplicates go first, or the unique index cannot be built: for each
-- token the most recently registered row stays (the account that last used the
-- phone), the others are deleted. They are exactly the rows this fix removes.
--
-- Wrapped: `migrate deploy` applies statement by statement, so a failure part-way
-- would leave the table half-changed and block every later deploy. The table is
-- small (a row per device), so building the index under the lock is quick.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- No insert from a release that is still running may land between the DELETE and the index build.
LOCK TABLE "push_tokens" IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM "push_tokens" a
 USING "push_tokens" b
 WHERE a."token" = b."token"
   AND (a."updated_at", a."id") < (b."updated_at", b."id");

CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_token_key" ON "push_tokens"("token");
DROP INDEX IF EXISTS "push_tokens_user_id_token_key";

COMMIT;
