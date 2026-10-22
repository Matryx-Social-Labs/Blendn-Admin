-- An ask the author is never shown (board_requests.silenced_at).
--
-- Between two people who already have a link (a friendship, any conversation
-- open or closed, any friend request) an ask is recorded as declined and
-- silenced at ask time: to the asker it is pending until it lapses, exactly as
-- a silent decline looks today; to the author it does not exist (no push, not in
-- their lists, not answerable). Deciding at ask time is what removes the
-- null-conversation accept and the closed-pair 409 that told the author
-- somebody they know had asked.
--
-- Nullable, no default: an ADD COLUMN of that shape rewrites nothing and every
-- existing row is NULL (never silenced). Additive and back-compatible.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "board_requests" ADD COLUMN IF NOT EXISTS "silenced_at" TIMESTAMPTZ(6);

COMMIT;
