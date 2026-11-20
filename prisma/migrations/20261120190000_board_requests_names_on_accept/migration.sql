-- Swap names on a Lobby accept (identity model, SCRUM-1094): whether the asker's app showed "If they say yes, you'll
-- both see each other's first name and photo" before the ask was sent. Only then, and only when the accepter's app
-- showed it too, does the accept open the chat already swapped; an ask from an older app opens unswapped.
-- Additive: NOT NULL with a constant default is metadata-only on PG 11+ (no rewrite). Wrapped, because
-- `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "board_requests" ADD COLUMN "names_on_accept" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
