-- Matchmaking: intent, reveal, and likes.
--
-- Additive throughout, so this applies to a live database with no backfill and
-- no downtime. Existing profiles get no intent (they have not been asked) and
-- `reveal_by_default` false, which is the posture the rest of the product takes.
--
-- **The array columns are nullable with no default, deliberately.** That looks
-- wrong — an empty array reads like the obvious default — but it is what Prisma
-- generates for a scalar list, and matching it is the whole job of this file.
-- Declaring them NOT NULL DEFAULT '{}' instead produced a database that passed
-- `prisma db push --accept-data-loss` as "in sync" and then failed every
-- check-in with a null constraint violation, because the generated client omits
-- a list it was not given rather than sending an empty one.
--
-- CI runs `db push` and production runs `migrate deploy`, so a divergence here
-- is invisible until the deploy. Verified by applying this to a copy of the
-- production schema and diffing `information_schema.columns` against a
-- `db push` of the same schema.

CREATE TYPE "connection_intent" AS ENUM ('dating', 'networking', 'friendship', 'just_here');

ALTER TABLE "profiles"
  ADD COLUMN "intent_default"    "connection_intent"[],
  ADD COLUMN "reveal_by_default" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "gender"            TEXT,
  ADD COLUMN "interested_in"     TEXT[];

ALTER TABLE "event_check_ins"
  ADD COLUMN "intent"   "connection_intent"[],
  ADD COLUMN "revealed" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "event_likes" (
  "id"         UUID           NOT NULL DEFAULT gen_random_uuid(),
  "event_id"   UUID           NOT NULL,
  "liker_id"   TEXT           NOT NULL,
  "liked_id"   TEXT           NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "event_likes_pkey" PRIMARY KEY ("id")
);

-- Liking twice is the same as liking once.
CREATE UNIQUE INDEX "event_likes_event_id_liker_id_liked_id_key"
  ON "event_likes" ("event_id", "liker_id", "liked_id");
-- "Has anyone liked me back?" runs on every like, and the unique index above
-- leads with the wrong side of the pair to answer it.
CREATE INDEX "event_likes_event_id_liked_id_idx" ON "event_likes" ("event_id", "liked_id");
-- Both sides get a leading index: deleting a User cascades on each, and an
-- unindexed FK makes Postgres scan the whole table per deleted row.
CREATE INDEX "event_likes_liker_id_idx" ON "event_likes" ("liker_id");
CREATE INDEX "event_likes_liked_id_idx" ON "event_likes" ("liked_id");

ALTER TABLE "event_likes"
  ADD CONSTRAINT "event_likes_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "event_likes_liker_id_fkey" FOREIGN KEY ("liker_id")
    REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "event_likes_liked_id_fkey" FOREIGN KEY ("liked_id")
    REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
