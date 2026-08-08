-- Settings that were shown and never stored, and rating the people you met.
--
-- Scalar lists stay nullable with no default, per the lesson in
-- 20260807_matchmaking: Prisma models them that way and omits them from an
-- INSERT, so NOT NULL DEFAULT '{}' passes `db push` as "in sync" and then fails
-- every insert. Booleans below are genuinely NOT NULL DEFAULT, which Prisma does
-- generate for `Boolean @default(true)`.

-- Default true because the settings screen has been claiming true for all four,
-- so nobody's apparent settings change on the day these start being honoured.
ALTER TABLE "profiles"
  ADD COLUMN "push_enabled"   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "show_online"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "read_receipts"  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "share_location" BOOLEAN NOT NULL DEFAULT true;

CREATE TYPE "peer_issue" AS ENUM ('none', 'uncomfortable', 'no_show', 'misrepresented', 'harassment');

CREATE TABLE "peer_ratings" (
  -- No database default: Prisma generates `@default(uuid())` client-side and
  -- emits no DEFAULT, so adding one here would diverge from what `db push`
  -- produces in CI.
  "id"         UUID           NOT NULL,
  "event_id"   UUID           NOT NULL,
  "rater_id"   TEXT           NOT NULL,
  "rated_id"   TEXT           NOT NULL,
  "rating"     INTEGER        NOT NULL,
  "issue"      "peer_issue"   NOT NULL DEFAULT 'none',
  "note"       TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "peer_ratings_pkey" PRIMARY KEY ("id")
);

-- One rating per pair per event, so a grudge cannot be expressed twice.
CREATE UNIQUE INDEX "peer_ratings_event_id_rater_id_rated_id_key"
  ON "peer_ratings" ("event_id", "rater_id", "rated_id");
-- The trust signal reads every rating about one person.
CREATE INDEX "peer_ratings_rated_id_idx" ON "peer_ratings" ("rated_id");
-- Both sides get a leading index: deleting a User cascades on each, and an
-- unindexed FK makes Postgres scan the whole table per deleted row.
CREATE INDEX "peer_ratings_rater_id_idx" ON "peer_ratings" ("rater_id");
-- The moderation queue: everything that reported something, newest first.
CREATE INDEX "peer_ratings_issue_created_at_idx" ON "peer_ratings" ("issue", "created_at");

ALTER TABLE "peer_ratings"
  ADD CONSTRAINT "peer_ratings_event_id_fkey" FOREIGN KEY ("event_id")
    REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "peer_ratings_rater_id_fkey" FOREIGN KEY ("rater_id")
    REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "peer_ratings_rated_id_fkey" FOREIGN KEY ("rated_id")
    REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
