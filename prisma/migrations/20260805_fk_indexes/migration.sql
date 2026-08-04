-- Index every foreign key that did not have one.
--
-- Postgres indexes the REFERENCED side of a foreign key (it has to, that side
-- is a unique key) but never the REFERENCING side. So `ON DELETE CASCADE` has
-- to find the children by scanning the child table, once per parent row.
--
-- This was found the hard way. Deleting a 2000-event load-test dataset from
-- staging failed three times and was blamed on batch size and on the
-- connection proxy. The real cause was `chat_messages.parent_id` — a
-- self-referencing FK for threaded replies, unindexed, so every one of the
-- ~50k cascaded messages triggered a sequential scan of the 500k-row
-- chat_messages table. Roughly 2.5e10 row comparisons; it was never going to
-- return. With the index the same delete finishes in under a minute.
--
-- The application hits the same path: deleting an event, a chat group, or a
-- user account (`app/api/mobile/account`) cascades through these tables. At
-- today's volume it is invisible; it degrades quadratically with growth.
--
-- IF NOT EXISTS because staging already has these, created by hand while
-- diagnosing the above.
--
-- Deliberately not CONCURRENTLY: prisma migrate runs each migration in a
-- transaction and CONCURRENTLY cannot run inside one. These tables are small
-- in every environment this will be applied to (production is ~44 users / 361
-- messages), so the ACCESS SHARE lock is held for milliseconds. Revisit if a
-- future environment is large when this runs.

CREATE INDEX IF NOT EXISTS "chat_messages_parent_id_idx" ON "chat_messages"("parent_id");
CREATE INDEX IF NOT EXISTS "message_reactions_user_id_idx" ON "message_reactions"("user_id");
CREATE INDEX IF NOT EXISTS "event_ratings_user_id_idx" ON "event_ratings"("user_id");
CREATE INDEX IF NOT EXISTS "event_reports_user_id_idx" ON "event_reports"("user_id");
CREATE INDEX IF NOT EXISTS "message_reports_reporter_id_idx" ON "message_reports"("reporter_id");
CREATE INDEX IF NOT EXISTS "user_reports_reporter_id_idx" ON "user_reports"("reporter_id");
CREATE INDEX IF NOT EXISTS "event_announcements_sent_by_idx" ON "event_announcements"("sent_by");
CREATE INDEX IF NOT EXISTS "user_interests_category_id_idx" ON "user_interests"("category_id");
CREATE INDEX IF NOT EXISTS "Account_userId_idx" ON "Account"("userId");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
