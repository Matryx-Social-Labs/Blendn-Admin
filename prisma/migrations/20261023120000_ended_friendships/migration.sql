-- A friendship that ended in the last 24 hours (B4, plans/friends-in-room.md D17).
--
-- Unfriending is silent. Without this, the ex-friend's stranger card appears in
-- the other's deck at that moment, which tells the unfriended person both what
-- happened and which pseudonym is theirs. So for 24 hours (the longest a room
-- stays open) the pair keep each other off every people surface in a room, as
-- friends do (`notStrangersTo`). Written by `unfriend` (an upsert, so a later
-- unfriend overwrites), deleted when they become friends again, read as
-- `ended_at > now() - interval '24 hours'`. No sweeper: rows are tiny. A block
-- writes none (the block already hides both ways).
--
-- Additive: a new table and an index, nothing existing is touched. The pair is
-- stored canonically, like `friendships` (user1 < user2 in the C collation).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "ended_friendships" (
    "user1_id" TEXT NOT NULL,
    "user2_id" TEXT NOT NULL,
    "ended_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ended_friendships_pkey" PRIMARY KEY ("user1_id", "user2_id"),
    CONSTRAINT "ended_friendships_canonical_pair" CHECK (("user1_id" COLLATE "C") < ("user2_id" COLLATE "C"))
);

CREATE INDEX "ended_friendships_user2_id_idx" ON "ended_friendships"("user2_id");

ALTER TABLE "ended_friendships" ADD CONSTRAINT "ended_friendships_user1_id_fkey" FOREIGN KEY ("user1_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ended_friendships" ADD CONSTRAINT "ended_friendships_user2_id_fkey" FOREIGN KEY ("user2_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
