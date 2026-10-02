-- Crew matching (step 8, plan v2 §6 "no voting", §8.3): likes between crews
-- and between a crew and one person, the Blend a mutual like makes, and the
-- Blend's room.
--
-- Person ↔ person stays `event_likes`: every crew_likes row has a crew on at
-- least one side. Any present member likes on the crew's behalf
-- (`liked_by_user_id`); nobody is told who liked first.
--
-- A Blend's side A is always a crew; side B is a crew with a greater id, or
-- one person. The ids are uuid, compared bytewise — no collation applies, so
-- the app's pair ordering and `blends_pair_order` cannot disagree (the trap
-- `CHECK (a < b)` under en_US.utf8 set for text ids). One row per pair per
-- occurrence: two sides liking each other at the same instant make one Blend.
--
-- Every foreign key is RESTRICT, as in the crews migration: crews are never
-- deleted, users are anonymised rather than deleted, and an occurrence is
-- deleted only when nobody attended it (lib/occurrences.ts), which a like or a
-- Blend — both need people checked in — cannot be.
--
-- Rolling back: as a NEW forward migration, never SQL run by hand against
-- staging or production. In order: export any Blend room's messages (kept
-- evidence); DELETE FROM chat_groups WHERE kind = 'blend'; restore
-- `chat_groups_one_owner` to its crews-migration form; DROP COLUMN
-- chat_groups.blend_id; DROP TABLE blends, crew_likes. The `blend` notification
-- kind stays (Postgres cannot drop an enum value). A rollback of the CODE alone
-- leaves Blend rooms its door refuses (no blend arm), which is safe.

ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'blend';

CREATE TABLE "crew_likes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurrence_id" UUID NOT NULL,
    "from_crew_id" UUID,
    "from_user_id" TEXT,
    "to_crew_id" UUID,
    "to_user_id" TEXT,
    "liked_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_likes_pkey" PRIMARY KEY ("id"),
    -- From a crew or from one person; to a crew or to one person.
    CONSTRAINT "crew_likes_one_from" CHECK (("from_crew_id" IS NULL) <> ("from_user_id" IS NULL)),
    CONSTRAINT "crew_likes_one_to" CHECK (("to_crew_id" IS NULL) <> ("to_user_id" IS NULL)),
    -- A crew on at least one side: person to person is `event_likes`.
    CONSTRAINT "crew_likes_has_a_crew" CHECK ("from_crew_id" IS NOT NULL OR "to_crew_id" IS NOT NULL),
    -- A crew never likes itself.
    CONSTRAINT "crew_likes_not_self" CHECK ("from_crew_id" IS DISTINCT FROM "to_crew_id" OR "from_crew_id" IS NULL),
    -- A person's own like is theirs: nobody likes "as" somebody else.
    CONSTRAINT "crew_likes_solo_is_the_liker" CHECK ("from_user_id" IS NULL OR "from_user_id" = "liked_by_user_id")
);

CREATE TABLE "blends" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurrence_id" UUID NOT NULL,
    "a_crew_id" UUID NOT NULL,
    "b_crew_id" UUID,
    "b_user_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closes_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "blends_pkey" PRIMARY KEY ("id"),
    -- Side B is a crew or one person, never both, never neither.
    CONSTRAINT "blends_one_b" CHECK (("b_crew_id" IS NULL) <> ("b_user_id" IS NULL)),
    -- Two crews in one order only, so a pair is one row.
    CONSTRAINT "blends_pair_order" CHECK ("b_crew_id" IS NULL OR "a_crew_id" < "b_crew_id")
);

-- Liking twice is liking once, per direction per occurrence (NULLs distinct:
-- each binds only its own shape). The occurrence leads all three, which is the
-- index its foreign key needs; every other foreign key has its own.
CREATE UNIQUE INDEX "crew_likes_occurrence_id_from_crew_id_to_crew_id_key" ON "crew_likes"("occurrence_id", "from_crew_id", "to_crew_id");
CREATE UNIQUE INDEX "crew_likes_occurrence_id_from_crew_id_to_user_id_key" ON "crew_likes"("occurrence_id", "from_crew_id", "to_user_id");
CREATE UNIQUE INDEX "crew_likes_occurrence_id_from_user_id_to_crew_id_key" ON "crew_likes"("occurrence_id", "from_user_id", "to_crew_id");
CREATE INDEX "crew_likes_from_crew_id_idx" ON "crew_likes"("from_crew_id");
CREATE INDEX "crew_likes_to_crew_id_idx" ON "crew_likes"("to_crew_id");
CREATE INDEX "crew_likes_from_user_id_idx" ON "crew_likes"("from_user_id");
CREATE INDEX "crew_likes_to_user_id_idx" ON "crew_likes"("to_user_id");
CREATE INDEX "crew_likes_liked_by_user_id_idx" ON "crew_likes"("liked_by_user_id");

CREATE UNIQUE INDEX "blends_occurrence_id_a_crew_id_b_crew_id_key" ON "blends"("occurrence_id", "a_crew_id", "b_crew_id");
CREATE UNIQUE INDEX "blends_occurrence_id_a_crew_id_b_user_id_key" ON "blends"("occurrence_id", "a_crew_id", "b_user_id");
CREATE INDEX "blends_a_crew_id_idx" ON "blends"("a_crew_id");
CREATE INDEX "blends_b_crew_id_idx" ON "blends"("b_crew_id");
CREATE INDEX "blends_b_user_id_idx" ON "blends"("b_user_id");
CREATE INDEX "blends_closes_at_idx" ON "blends"("closes_at");

ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_occurrence_id_fkey"
  FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_from_crew_id_fkey"
  FOREIGN KEY ("from_crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_to_crew_id_fkey"
  FOREIGN KEY ("to_crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_from_user_id_fkey"
  FOREIGN KEY ("from_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_to_user_id_fkey"
  FOREIGN KEY ("to_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_likes" ADD CONSTRAINT "crew_likes_liked_by_user_id_fkey"
  FOREIGN KEY ("liked_by_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "blends" ADD CONSTRAINT "blends_occurrence_id_fkey"
  FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "blends" ADD CONSTRAINT "blends_a_crew_id_fkey"
  FOREIGN KEY ("a_crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "blends" ADD CONSTRAINT "blends_b_crew_id_fkey"
  FOREIGN KEY ("b_crew_id") REFERENCES "crews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "blends" ADD CONSTRAINT "blends_b_user_id_fkey"
  FOREIGN KEY ("b_user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The Blend room: owned by its Blend, one per Blend.
ALTER TABLE "chat_groups" ADD COLUMN "blend_id" UUID;
CREATE UNIQUE INDEX "chat_groups_blend_id_key" ON "chat_groups"("blend_id");
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_blend_id_fkey"
  FOREIGN KEY ("blend_id") REFERENCES "blends"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one owner, the one the kind names: every kind has its arm now.
ALTER TABLE "chat_groups" DROP CONSTRAINT "chat_groups_one_owner";
ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_one_owner" CHECK (
  ("kind" = 'event' AND "event_id" IS NOT NULL AND "board_post_id" IS NULL AND "crew_id" IS NULL AND "blend_id" IS NULL)
  OR ("kind" = 'board_post' AND "board_post_id" IS NOT NULL AND "event_id" IS NULL AND "crew_id" IS NULL AND "blend_id" IS NULL)
  OR ("kind" = 'crew' AND "crew_id" IS NOT NULL AND "event_id" IS NULL AND "board_post_id" IS NULL AND "blend_id" IS NULL)
  OR ("kind" = 'blend' AND "blend_id" IS NOT NULL AND "event_id" IS NULL AND "board_post_id" IS NULL AND "crew_id" IS NULL)
);
