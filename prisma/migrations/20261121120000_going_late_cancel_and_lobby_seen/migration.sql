-- Going lifecycle (SCRUM-1095, ROADMAP Going 2 and 6).
--
-- 1. `event_rsvps.cancelled_at`: when somebody who was going (or maybe, or on the waitlist) withdrew once the doors
--    were open. The row is kept as `not_going` instead of deleted, so the turn-out forecast and the show rate can tell
--    "can't make it" from a no-show. NULL on every other row, including a `not_going` said before the doors.
-- 2. `board_seen`: when a person last saw an event's Lobby (the newest post's time on the page they were shown), so
--    Going's rows can say "Lobby · N new" on any phone. Purged with the alert switches when the Lobby closes.
--
-- Additive: a nullable column and a new table, no rewrite. Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_rsvps" ADD COLUMN "cancelled_at" TIMESTAMPTZ(6);

CREATE TABLE "board_seen" (
    "user_id" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "seen_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "board_seen_pkey" PRIMARY KEY ("user_id", "event_id")
);

CREATE INDEX "board_seen_event_id_idx" ON "board_seen"("event_id");

ALTER TABLE "board_seen" ADD CONSTRAINT "board_seen_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "board_seen" ADD CONSTRAINT "board_seen_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
