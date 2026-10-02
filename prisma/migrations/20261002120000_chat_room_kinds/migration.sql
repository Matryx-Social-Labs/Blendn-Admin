-- Chat rooms of every kind (step 7, plan v2 §7 and §12.1 F8/F9).
--
-- A room had exactly one event. Crew chats, Blend rooms and board-post groups
-- are rooms that belong to something else, so a room now has a `kind` and one
-- owner of that kind. Every existing row becomes kind 'event' through the
-- default, keeps its event, and satisfies the CHECK below as it stands.
--
-- Only `board_post` gets its owner column here: `board_posts` exists. `crews`
-- and `blends` do not yet, so their owner columns and foreign keys arrive with
-- those tables in step 8, which widens `chat_groups_one_owner` in the same
-- migration. Until then the CHECK has no arm for them, so a crew or blend room
-- cannot be written at all: no room without an owner, and no FK to nothing.
--
-- `event_id` keeps its plain UNIQUE index. NULLs are distinct in Postgres, so
-- with the CHECK it is exactly "one room per event, any number of rooms with
-- no event" — what a partial unique WHERE kind = 'event' would say — and
-- schema.prisma can express it, so Prisma's by-event lookups and upserts stay.
--
-- Rolling back: as a NEW forward migration, deployed like any other -- never
-- SQL run by hand against staging or production (the next boot's
-- `migrate deploy` dies on a schema it did not write). In order:
--   1. DELETE FROM message_reports WHERE message_type = 'group' AND message_id
--      IN (the chat_messages of rooms whose kind <> 'event'). No foreign key:
--      they would be left pointing at nothing.
--   2. DELETE FROM chat_groups WHERE kind <> 'event' (cascades their
--      messages, reactions and members -- export first if any exist).
--   3. ALTER TABLE chat_groups DROP CONSTRAINT chat_groups_one_owner,
--      DROP COLUMN board_post_id, DROP COLUMN kind,
--      ALTER COLUMN event_id SET NOT NULL; DROP TYPE chat_group_kind.
-- A rollback of the CODE alone is safe while no room of another kind exists,
-- which is until something writes one (step 8 / the board-post room): old
-- code dereferences `chat_group.event` unconditionally and would 500 on one.

CREATE TYPE "chat_group_kind" AS ENUM ('event', 'crew', 'blend', 'board_post');

ALTER TABLE "chat_groups"
  ADD COLUMN "kind" "chat_group_kind" NOT NULL DEFAULT 'event',
  ADD COLUMN "board_post_id" UUID,
  ALTER COLUMN "event_id" DROP NOT NULL;

-- One room per post. Also the index the foreign key's cascade seeks on
-- (fk-indexes.itest.ts).
CREATE UNIQUE INDEX "chat_groups_board_post_id_key" ON "chat_groups"("board_post_id");

ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_board_post_id_fkey"
  FOREIGN KEY ("board_post_id") REFERENCES "board_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exactly one owner, and the one the kind names. Schema.prisma cannot express
-- it and `db push` drops it (CLAUDE.md), so lib/room-kind.ts also fails closed
-- on a room whose owner is missing. Step 8 adds an arm per new owner column.
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_one_owner" CHECK (
  ("kind" = 'event' AND "event_id" IS NOT NULL AND "board_post_id" IS NULL)
  OR ("kind" = 'board_post' AND "board_post_id" IS NOT NULL AND "event_id" IS NULL)
);
