-- Crews (step 8, plan v2 §6): friends who go out together, their chat, and
-- the switches crew matching reads.
--
-- A crew is made from the friend graph and every member joined by accepting,
-- which is also their consent to the crew reveal (`consented_reveal_at`, NOT
-- NULL: no member without it). A crew is never deleted: one that drops below
-- two members is dissolved (`dissolved_at`, D-15) and its room archived, so
-- the other members' messages are kept like every room's. Every foreign key
-- here is RESTRICT for that reason, and because a `User` row is never deleted
-- either (account erasure anonymises it and removes the person's crew rows
-- itself, app/api/mobile/account).
--
-- Presence is NOT a column: "here tonight" is two or more members checked into
-- the same occurrence, a query over `event_check_ins` (lib/crews/presence.ts),
-- so it cannot drift from where people are.
--
-- The member cap (CREW.MAX_MEMBERS, 12) is not a CHECK — a CHECK cannot count
-- rows. Every writer adds a member through lib/crews/crews.ts, which counts
-- under a row lock on the crew (SELECT ... FOR UPDATE), so two accepts at once
-- cannot both take the twelfth seat.
--
-- Rolling back: as a NEW forward migration, never SQL run by hand against
-- staging or production (the next boot's `migrate deploy` dies on a schema it
-- did not write). In order: archive and export any crew room's messages (they
-- are kept evidence); DELETE FROM chat_groups WHERE kind = 'crew'; restore
-- `chat_groups_one_owner` to its step-7 form; DROP TABLE crew_invites,
-- crew_members, crews; DROP TYPE crew_role; DROP COLUMN events.crews_enabled
-- and event_match_preferences.open_to_crews. The two notification kinds stay
-- (Postgres cannot drop an enum value); nothing writes them after the code
-- rollback. A rollback of the CODE alone is safe while no crew room exists:
-- the step-7 code refuses a crew room at its door.

CREATE TYPE "crew_role" AS ENUM ('owner', 'member');

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'crew_invite';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'crew_here';

CREATE TABLE "crews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "bio" TEXT,
    "intent" "connection_intent"[] NOT NULL DEFAULT '{}',
    "tags" TEXT[] NOT NULL DEFAULT '{}',
    "emblem_seed" TEXT NOT NULL,
    "open_to_solo" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dissolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "crews_pkey" PRIMARY KEY ("id"),
    -- Counted in characters, as the app counts them (`[...text].length`), so
    -- an emoji is one. Not unique: two crews may share a name.
    CONSTRAINT "crews_name_length" CHECK (char_length("name") BETWEEN 2 AND 32),
    CONSTRAINT "crews_bio_length" CHECK ("bio" IS NULL OR char_length("bio") <= 140),
    -- Curated slugs, at most three (the slugs themselves are the app's list).
    CONSTRAINT "crews_tags_max" CHECK (cardinality("tags") <= 3)
);

CREATE TABLE "crew_members" (
    "crew_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "crew_role" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keep_me_anonymous" BOOLEAN NOT NULL DEFAULT false,
    "consented_reveal_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "crew_members_pkey" PRIMARY KEY ("crew_id","user_id")
);

CREATE TABLE "crew_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "crew_id" UUID NOT NULL,
    "invited_user_id" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declined_at" TIMESTAMPTZ(6),

    CONSTRAINT "crew_invites_pkey" PRIMARY KEY ("id"),
    -- Nobody invites themselves.
    CONSTRAINT "crew_invites_not_self" CHECK ("invited_user_id" <> "invited_by")
);

-- Every foreign key has an index leading on it (fk-indexes.itest.ts):
-- crew_members(crew_id) and crew_invites(crew_id) lead their PK / unique.
CREATE INDEX "crews_created_by_idx" ON "crews"("created_by");
CREATE INDEX "crew_members_user_id_idx" ON "crew_members"("user_id");
CREATE INDEX "crew_invites_invited_user_id_idx" ON "crew_invites"("invited_user_id");
CREATE INDEX "crew_invites_invited_by_idx" ON "crew_invites"("invited_by");
CREATE UNIQUE INDEX "crew_invites_crew_id_invited_user_id_key" ON "crew_invites"("crew_id", "invited_user_id");

ALTER TABLE "crews" ADD CONSTRAINT "crews_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_fkey"
  FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_crew_id_fkey"
  FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_invited_user_id_fkey"
  FOREIGN KEY ("invited_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_invites" ADD CONSTRAINT "crew_invites_invited_by_fkey"
  FOREIGN KEY ("invited_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The crew chat: a room owned by its crew. One per crew; RESTRICT, as every
-- room owner is, because the room is other people's messages.
ALTER TABLE "chat_groups" ADD COLUMN "crew_id" UUID;
CREATE UNIQUE INDEX "chat_groups_crew_id_key" ON "chat_groups"("crew_id");
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_crew_id_fkey"
  FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one owner, and the one the kind names: step 7's CHECK, widened by
-- the crew arm. A `blend` room still cannot be written (its owner arrives with
-- `blends`). lib/room-kind.ts also fails closed on a room whose owner is
-- missing, because `db push` drops this.
ALTER TABLE "chat_groups" DROP CONSTRAINT "chat_groups_one_owner";
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_one_owner" CHECK (
  ("kind" = 'event' AND "event_id" IS NOT NULL AND "board_post_id" IS NULL AND "crew_id" IS NULL)
  OR ("kind" = 'board_post' AND "board_post_id" IS NOT NULL AND "event_id" IS NULL AND "crew_id" IS NULL)
  OR ("kind" = 'crew' AND "crew_id" IS NOT NULL AND "event_id" IS NULL AND "board_post_id" IS NULL)
);

-- The host's switch (the kit's "Allow group check-in"), on unless turned off.
ALTER TABLE "events" ADD COLUMN "crews_enabled" BOOLEAN NOT NULL DEFAULT true;

-- A solo person's "Open to joining a crew tonight", per event, off by default.
ALTER TABLE "event_match_preferences" ADD COLUMN "open_to_crews" BOOLEAN NOT NULL DEFAULT false;
