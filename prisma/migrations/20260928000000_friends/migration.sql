-- Friends: two people who both said yes, reached only through a link one of
-- them gave out or someone the other can already see. No lookup of any kind.
-- See `friendships` in schema.prisma and lib/friends.ts.
--
-- Hand-written: `migrate dev` against this schema also emits unrelated drift
-- (id defaults, FK re-creates, index renames) that is not this change's to make.

ALTER TYPE "notification_kind" ADD VALUE 'friend_request';
ALTER TYPE "notification_kind" ADD VALUE 'friend_accepted';

-- Friends stay pseudonyms in a room unless the person turns this on.
ALTER TABLE "profiles" ADD COLUMN "friends_see_me_in_rooms" BOOLEAN NOT NULL DEFAULT false;

-- A friend's DM must not count as "in a conversation" for room identity.
ALTER TABLE "private_conversations" ADD COLUMN "origin_friendship" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "friendships" (
    "id" UUID NOT NULL,
    "user1_id" TEXT NOT NULL,
    "user2_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "friend_requests" (
    "id" UUID NOT NULL,
    "sender_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "dismissed_at" TIMESTAMPTZ(6),
    "withdrawn_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "friend_invites" (
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "friend_invites_pkey" PRIMARY KEY ("user_id")
);

CREATE UNIQUE INDEX "friendships_user1_id_user2_id_key" ON "friendships"("user1_id", "user2_id");
CREATE INDEX "friendships_user2_id_idx" ON "friendships"("user2_id");
CREATE UNIQUE INDEX "friend_requests_sender_id_recipient_id_key" ON "friend_requests"("sender_id", "recipient_id");
CREATE INDEX "friend_requests_recipient_id_dismissed_at_withdrawn_at_created_at_idx" ON "friend_requests"("recipient_id", "dismissed_at", "withdrawn_at", "created_at");
CREATE UNIQUE INDEX "friend_invites_token_key" ON "friend_invites"("token");

ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user1_id_fkey" FOREIGN KEY ("user1_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user2_id_fkey" FOREIGN KEY ("user2_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "friend_invites" ADD CONSTRAINT "friend_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Pairs are stored in canonical order (see conversationPair) and a person
-- cannot befriend or ask themselves; the database says so too.
--
-- COLLATE "C": conversationPair sorts with JS, which compares code units, and
-- the database's default collation (en_US.utf8 here and on Railway) does not —
-- it de-weights punctuation, so 'x_fr-own_…' and 'x_fr-owner_…' sort one way in
-- JS and the other in Postgres, and the insert would fail this CHECK. Byte
-- order is the one both agree on.
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_canonical_pair" CHECK (("user1_id" COLLATE "C") < ("user2_id" COLLATE "C"));
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_not_self" CHECK ("sender_id" <> "recipient_id");
