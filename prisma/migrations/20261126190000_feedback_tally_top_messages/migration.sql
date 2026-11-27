-- The dominance rule after the purge (SCRUM-1285).
--
-- A complaint category one person wrote most of is held back (`MAX_DOMINANCE`, lib/disclosure.ts). Once the 180-day
-- purge has detached every feedback row from its author, the largest single person's messages per category can no
-- longer be counted, so the purge freezes it here beside `contributors`, while every author is still known.
-- `{ [category]: messages }`. NULL on a tally frozen before this: the digest then reads it without dominance, as before.
--
-- Additive: one nullable column, no rewrite. Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "event_feedback_tallies" ADD COLUMN "top_messages" JSONB;

COMMIT;
