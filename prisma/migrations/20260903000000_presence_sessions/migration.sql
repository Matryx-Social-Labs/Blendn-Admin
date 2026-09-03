-- Presence as sessions, not as a status.
--
-- Additive: `event_check_ins` is untouched and remains the source of truth
-- until readers move. Nothing in this migration can break an existing
-- environment, which is deliberate — the model change is large enough without
-- a cutover happening in the same step.

CREATE TYPE "departure_source" AS ENUM ('user', 'sweeper', 'switch', 'ended', 'expired');
CREATE TYPE "presence_source" AS ENUM ('os_geofence', 'polling');

CREATE TABLE "presence_sessions" (
  "id"              UUID             NOT NULL DEFAULT gen_random_uuid(),
  "event_id"        UUID             NOT NULL,
  "occurrence_id"   UUID             NOT NULL,
  "user_id"         TEXT             NOT NULL,
  "kind"            "check_in_kind"  NOT NULL DEFAULT 'attendee',

  "arrived_at"      TIMESTAMPTZ      NOT NULL,
  "departed_at"     TIMESTAMPTZ,
  "departed_source" "departure_source",

  "last_seen_at"    TIMESTAMPTZ,
  "last_lat"        DOUBLE PRECISION,
  "last_lng"        DOUBLE PRECISION,
  "last_accuracy"   DOUBLE PRECISION,

  "source"          "presence_source" NOT NULL DEFAULT 'polling',

  "created_at"      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  "updated_at"      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),

  CONSTRAINT "presence_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "presence_sessions_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "presence_sessions_occurrence_id_fkey"
    FOREIGN KEY ("occurrence_id") REFERENCES "event_occurrences"("id") ON DELETE CASCADE,
  CONSTRAINT "presence_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE
);

-- "Who is inside now" — the live-ops question, twelve times a minute per
-- watched event.
CREATE INDEX "presence_sessions_occurrence_id_departed_at_idx"
  ON "presence_sessions"("occurrence_id", "departed_at");
-- The arrival curve and the entry alert.
CREATE INDEX "presence_sessions_event_id_arrived_at_idx"
  ON "presence_sessions"("event_id", "arrived_at");
-- One person's history: GET /me/attendance, and the second-event rate.
CREATE INDEX "presence_sessions_user_id_arrived_at_idx"
  ON "presence_sessions"("user_id", "arrived_at");

-- THE invariant, and the reason this migration exists rather than a `@@unique`
-- in schema.prisma: **at most one OPEN session per person per occurrence.**
--
-- Many sessions per pair is the entire point of the model — that is what makes
-- leaving and coming back representable. So a plain unique is exactly wrong.
-- What must never happen is two sessions open at once, because then occupancy
-- counts one body twice, which is the failure this model was built to remove,
-- walking back in through the door marked "many sessions are allowed".
--
-- `schema.prisma` cannot express a partial index, so this lives here and only
-- here. CLAUDE.md already records what that costs: a `db push` database gets
-- none of it and is therefore strictly weaker than production, and comparing
-- the two by columns alone will not show the difference.
CREATE UNIQUE INDEX "presence_sessions_one_open_per_occurrence"
  ON "presence_sessions"("occurrence_id", "user_id")
  WHERE "departed_at" IS NULL;

-- A closed session cannot end before it began. Cheap, and it makes a dwell
-- calculation that returns a negative number impossible rather than merely
-- unlikely — `sum(departed_at - arrived_at)` is the whole point of the table.
ALTER TABLE "presence_sessions"
  ADD CONSTRAINT "presence_sessions_departure_after_arrival"
  CHECK ("departed_at" IS NULL OR "departed_at" >= "arrived_at");
