-- Positive topics (SCRUM-1101, dashboard insights D5): what a positive message liked, one of five labels, never the words.
--
-- 1. `event_feedback.topic`: NULL on every row classified before this, on every message that is not positive, and on a
--    positive one that names none of the five.
-- 2. `event_feedback_tallies.topics`: distinct people per topic, frozen by the 180-day purge beside `contributors`,
--    while every author is still known. NULL on a tally frozen before this.
--
-- Additive: a new type and two nullable columns, no rewrite. Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "feedback_topic" AS ENUM ('people', 'music', 'program', 'food_drink', 'place');

ALTER TABLE "event_feedback" ADD COLUMN "topic" "feedback_topic";

ALTER TABLE "event_feedback_tallies" ADD COLUMN "topics" JSONB;

COMMIT;
