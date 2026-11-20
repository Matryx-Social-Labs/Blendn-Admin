-- Where a friend request came from (Flow 7 2-A, 4-A: "From your link" / "From a match"): `link` for an invite link,
-- `match` for a match both people revealed in (`POST /friends/requests` with a user id). Null for every request made
-- before this column: the source was never recorded, and guessing it would put a wrong line on somebody's request.
-- Additive: a nullable column with no default (no rewrite) and a CHECK on it. Wrapped, because `migrate deploy` is not
-- transactional; the ALTERs take a brief lock on a small table, and the CHECK validates a column that is null everywhere.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "friend_requests" ADD COLUMN "via" TEXT;
ALTER TABLE "friend_requests"
  ADD CONSTRAINT "friend_requests_via_known" CHECK ("via" IS NULL OR "via" IN ('link', 'match'));

COMMIT;
