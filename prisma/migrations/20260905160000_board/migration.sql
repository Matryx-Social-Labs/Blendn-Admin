-- The pre-event board: going alone, and looking for somebody to go with.
--
-- The fifth primitive is INTENT, and this is what gives `event_rsvps` a job.
-- An RSVP has been a dead-end signal that exists as a dashboard number; the
-- board is the gate that makes it mean something.

-- Guarded, because a migration that creates a type and then fails on a table
-- leaves the type behind — and the retry then dies on "already exists" rather
-- than on the original problem, which is the error somebody actually needs to
-- see. Postgres has no CREATE TYPE IF NOT EXISTS, so this is the idiom.
DO $$ BEGIN
  CREATE TYPE "board_post_kind" AS ENUM ('offer', 'seeking', 'chat');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "board_request_status" AS ENUM ('pending', 'accepted', 'declined', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "board_posts" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"          UUID NOT NULL,
  "author_id"         TEXT NOT NULL,
  "kind"              "board_post_kind" NOT NULL,
  "body"              TEXT NOT NULL,
  "spaces_left"       INTEGER,
  "moderation_status" TEXT,
  "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "deleted_at"        TIMESTAMPTZ(6),
  CONSTRAINT "board_posts_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "board_posts_author_id_fkey"
    FOREIGN KEY ("author_id") REFERENCES "User"("id") ON DELETE CASCADE,
  -- `spaces_left` is only meaningful on an offer, and must never be negative.
  -- A zero is "the car is full", which is a real and different state from
  -- "this post was never about spaces" — hence nullable rather than defaulted.
  CONSTRAINT "board_posts_spaces_non_negative"
    CHECK ("spaces_left" IS NULL OR "spaces_left" >= 0),
  CONSTRAINT "board_posts_spaces_only_on_offer"
    CHECK ("spaces_left" IS NULL OR "kind" = 'offer')
);

CREATE INDEX IF NOT EXISTS "board_posts_event_id_deleted_at_created_at_idx"
  ON "board_posts"("event_id", "deleted_at", "created_at");
CREATE INDEX IF NOT EXISTS "board_posts_author_id_created_at_idx"
  ON "board_posts"("author_id", "created_at");

CREATE TABLE IF NOT EXISTS "board_requests" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"     UUID NOT NULL,
  "post_id"      UUID NOT NULL,
  "from_user_id" TEXT NOT NULL,
  "to_user_id"   TEXT NOT NULL,
  "status"       "board_request_status" NOT NULL DEFAULT 'pending',
  "message"      TEXT,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "decided_at"   TIMESTAMPTZ(6),
  CONSTRAINT "board_requests_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "board_requests_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "board_posts"("id") ON DELETE CASCADE,
  CONSTRAINT "board_requests_from_user_id_fkey"
    FOREIGN KEY ("from_user_id") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "board_requests_to_user_id_fkey"
    FOREIGN KEY ("to_user_id") REFERENCES "User"("id") ON DELETE CASCADE,
  -- Answering your own post is not a request, it is a typo.
  CONSTRAINT "board_requests_not_self" CHECK ("from_user_id" <> "to_user_id"),
  -- A decision has a time, and an undecided request has not got one. Keeping
  -- these consistent is what stops "accepted" rows with no `decided_at`
  -- accumulating and making any question about response time unanswerable.
  CONSTRAINT "board_requests_decided_has_time"
    CHECK (("status" = 'pending') = ("decided_at" IS NULL))
);

CREATE INDEX IF NOT EXISTS "board_requests_to_user_id_status_created_at_idx"
  ON "board_requests"("to_user_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "board_requests_from_user_id_status_created_at_idx"
  ON "board_requests"("from_user_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "board_requests_post_id_idx" ON "board_requests"("post_id");
-- The cascade path: `events` deletion fans out through here, and an unindexed
-- foreign key makes that a sequential scan.
CREATE INDEX IF NOT EXISTS "board_requests_event_id_idx" ON "board_requests"("event_id");

-- The invariant `schema.prisma` cannot express.
--
-- At most ONE PENDING request per asker per post. Without it, tapping twice on
-- a slow connection asks the same person the same question twice — exactly the
-- pestering the outstanding-request cap exists to prevent, arriving through a
-- double tap rather than through persistence.
--
-- Scoped to pending on purpose: a declined request that is later re-sent is a
-- second ask, and whether that is allowed is the cap's decision to make, not
-- the database's.
CREATE UNIQUE INDEX IF NOT EXISTS "board_requests_one_pending_per_post"
  ON "board_requests"("post_id", "from_user_id")
  WHERE "status" = 'pending';
