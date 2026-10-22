-- A friend request that is waiting for a match to be revealed on both sides.
--
-- A pair whose only conversation is a pseudonymous one (a match, a board post)
-- that is not yet revealed on both sides cannot be made friends: the friends
-- surfaces name people and return their DM, and that DM is still "Heron". The
-- request is recorded (the asker is told "requested", as always) but held: no
-- push, nothing in the recipient's list, and it cannot be accepted, until both
-- have revealed, when it is released (held_at cleared) and delivered.
--
-- Nullable, no default, unindexed: an ADD COLUMN of that shape rewrites nothing,
-- every existing row is NULL (never held), and held rows are read through the
-- sender/recipient indexes already there. Additive and back-compatible: an
-- older build that does not know the column reads and writes every row as before.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "friend_requests" ADD COLUMN IF NOT EXISTS "held_at" TIMESTAMPTZ(6);

COMMIT;
