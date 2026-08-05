-- Classified feedback from an event's post-event chat window.
--
-- The chatroom stays open after the event ends so attendees say what they think
-- while still outside the venue — the honest review no emailed survey gets.
-- This stores what each message was about, not just how it felt: "12 negative"
-- is not actionable, "9 of 12 are the bar queue" is.
--
-- The category set is drawn from live-event operations research rather than
-- invented. safety_conduct escalates to moderation regardless of sentiment,
-- because a calmly-worded report of harassment is still a report.

CREATE TYPE "feedback_sentiment" AS ENUM ('positive', 'neutral', 'negative');
CREATE TYPE "feedback_source" AS ENUM ('lexicon', 'llm', 'human');
CREATE TYPE "issue_category" AS ENUM (
    'entry_queue', 'crowding', 'facilities', 'sound_av', 'staff_service',
    'food_drink', 'wayfinding', 'technical', 'safety_conduct', 'other'
);

-- Separate table rather than columns on chat_messages: only a small subset of
-- messages are ever classified, and chat_messages is the hot table (half a
-- million rows at load-test volume), so keeping it narrow beats avoiding a join.
CREATE TABLE "event_feedback" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id"     UUID NOT NULL,
    "message_id"   UUID NOT NULL,
    "sentiment"    "feedback_sentiment" NOT NULL,
    "category"     "issue_category" NOT NULL,
    -- 0-1. A lexicon label and an LLM label must not present as equally
    -- authoritative, so the UI reads this to decide how certain to look.
    "confidence"   DOUBLE PRECISION NOT NULL,
    "source"       "feedback_source" NOT NULL,
    -- The organiser's override, and the ground truth. The classifier misses
    -- sarcasm often enough that correcting it is a designed affordance.
    "corrected_by" TEXT,
    "corrected_at" TIMESTAMPTZ(6),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_feedback_pkey" PRIMARY KEY ("id")
);

-- One classification per message. Re-classifying updates in place rather than
-- accumulating rows, so a digest cannot double-count a message.
CREATE UNIQUE INDEX "event_feedback_message_id_key" ON "event_feedback"("message_id");

ALTER TABLE "event_feedback" ADD CONSTRAINT "event_feedback_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "event_feedback" ADD CONSTRAINT "event_feedback_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every dashboard read is scoped to one event and then grouped: the digest by
-- sentiment, the live view by category, the feed by time.
CREATE INDEX "event_feedback_event_id_created_at_idx" ON "event_feedback"("event_id", "created_at");
CREATE INDEX "event_feedback_event_id_category_idx" ON "event_feedback"("event_id", "category");
CREATE INDEX "event_feedback_event_id_sentiment_idx" ON "event_feedback"("event_id", "sentiment");
