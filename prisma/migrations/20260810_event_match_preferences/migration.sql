-- Per-event preferences get their own table, and stop being ambiguous.
--
-- `intent` and `revealed` lived on `event_check_ins`, which was correct while a
-- check-in was one row per event. The occurrences migration changed the key to
-- `(occurrence_id, user_id)`, so a five-day conference gives one person five
-- check-in rows — and both readers fetched the value with
-- `findFirst({ event_id, user_id })`: no occurrence scoping, no ordering.
--
-- Postgres is free to return any matching row for an unordered `LIMIT 1`, and
-- which one it picks can change with a vacuum, a plan change or an index. So on
-- any multi-day event, your intent and your reveal state were whichever row
-- came back first — silently, and not reliably reproducible, which is the worst
-- combination to debug. The unique constraint below makes it impossible rather
-- than unlikely.
--
-- ## The backfill is not "take the latest row"
--
-- `revealed` folds with bool_or: if someone revealed on **any** day of an
-- event, they stay revealed. That is exactly what `lib/identity.ts` already
-- does — it asks whether a `revealed: true` check-in exists at a shared event —
-- so taking only the most recent row would retroactively hide identity from
-- someone who could already see it, and could close a conversation that is open.
--
-- `intent` takes the row with the greatest `check_in_time`, which is the most
-- recent answer the person actually gave. NULL times sort last so a pending
-- check-in never outranks a real one.
--
-- ## The old columns stay for one release
--
-- Nothing reads or writes them from 0.65.0. They are dropped in the release
-- after, so a rollback has something to roll back to — dropping a column in the
-- same deploy that stops using it means the previous build cannot run at all.

CREATE TABLE "event_match_preferences" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"   UUID NOT NULL,
    "user_id"    TEXT NOT NULL,
    "intent"     "connection_intent"[] DEFAULT ARRAY[]::"connection_intent"[],
    "revealed"   BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_match_preferences_pkey" PRIMARY KEY ("id")
);

-- The constraint that makes "one answer per person per event" true rather than
-- merely intended.
CREATE UNIQUE INDEX "event_match_preferences_event_id_user_id_key"
    ON "event_match_preferences" ("event_id", "user_id");

CREATE INDEX "event_match_preferences_user_id_idx"
    ON "event_match_preferences" ("user_id");

ALTER TABLE "event_match_preferences"
    ADD CONSTRAINT "event_match_preferences_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "event_match_preferences_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill. `revealed` folds across the event; `intent` comes from the most
-- recent check-in that has a time.
INSERT INTO "event_match_preferences" ("event_id", "user_id", "intent", "revealed", "created_at")
SELECT
    folded.event_id,
    folded.user_id,
    COALESCE(latest.intent, ARRAY[]::"connection_intent"[]),
    folded.revealed,
    folded.first_seen
FROM (
    SELECT
        event_id,
        user_id,
        bool_or(revealed)     AS revealed,
        min(created_at)       AS first_seen
    FROM "event_check_ins"
    GROUP BY event_id, user_id
) AS folded
LEFT JOIN LATERAL (
    SELECT c.intent
    FROM "event_check_ins" c
    WHERE c.event_id = folded.event_id
      AND c.user_id = folded.user_id
    ORDER BY c.check_in_time DESC NULLS LAST, c.created_at DESC
    LIMIT 1
) AS latest ON TRUE;
