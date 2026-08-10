-- Reports become reviewable.
--
-- `user_reports` and `message_reports` have been written by two mobile routes
-- and read by nothing at all. A harassment report produced a row no human was
-- ever going to see, in a product whose stated differentiator is that somebody
-- is accountable for the room.
--
-- They already carry `status report_status DEFAULT 'pending'`, so the queue
-- itself needs no new column. What is missing is the other half of a decision:
-- who made it and when. `moderation_flags` has carried `reviewed_by` and
-- `reviewed_at` since it was introduced, and a reports queue that records only
-- the outcome is one that cannot answer "who cleared this" three weeks later —
-- which is the question that gets asked.
--
-- `reviewed_by` is a plain TEXT holding a `User.id`, not a foreign key. Same
-- choice as `chat_group_members.banned_by` and `users.suspended_by`: the
-- decision outlives the reviewer's account, and an ON DELETE CASCADE here would
-- quietly erase the trail exactly when an admin leaves. `audit_logs` is the
-- durable record; these two columns are what the queue renders.

ALTER TABLE "user_reports"
  ADD COLUMN "reviewed_by" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);

ALTER TABLE "message_reports"
  ADD COLUMN "reviewed_by" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);

-- The queue reads pending-first and orders by age, on both tables, every load.
CREATE INDEX "user_reports_status_created_at_idx"    ON "user_reports"    ("status", "created_at");
CREATE INDEX "message_reports_status_created_at_idx" ON "message_reports" ("status", "created_at");
