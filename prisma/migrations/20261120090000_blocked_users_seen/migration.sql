-- The blocked list could not tell one "Someone" from another: a person blocked
-- from a room, a board post or a Lobby was never named to the blocker, and the
-- list had nothing else to say (SCRUM-1082, SCRUM-1076). So each block now
-- keeps what the blocker saw at the time:
--   seen_as  the pseudonym they were shown (never a real name)
--   seen_in  the place's name: the event, venue day or room they blocked from
-- Snapshots, not keys, for the reason `private_conversations.user1_pseudonym`
-- gives: the room's members are swept and the block outlives them.
-- Additive: two nullable columns, no default, so no rewrite and every existing
-- row reads null ("not recorded"). Wrapped, because `migrate deploy` is not
-- transactional; the ALTER takes a brief ACCESS EXCLUSIVE lock on a small table.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "blocked_users" ADD COLUMN "seen_as" TEXT, ADD COLUMN "seen_in" TEXT;

COMMIT;
