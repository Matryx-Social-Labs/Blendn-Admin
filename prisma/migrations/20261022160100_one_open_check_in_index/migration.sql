-- One open check-in per person (SCRUM-705), part 2 of 2: the rule, in the
-- database. lib/check-in-core.ts recovers a lost race by this index's NAME
-- (`ONE_OPEN_CHECK_IN`), so renaming it is a code change too.
--
-- Covers venue days as well as events: a Go Live is a check-in row like any
-- other, and you cannot be live at a bar and checked in to a gig at once.
--
-- CONCURRENTLY, alone in its file and not wrapped: it cannot run inside a
-- transaction, and a plain CREATE INDEX would hold writes on every door in the
-- product for the length of the build. If it fails it leaves an INVALID index
-- behind; IF NOT EXISTS would then skip it, so recovery is
-- `DROP INDEX CONCURRENTLY "event_check_ins_one_open_per_user";` in a new
-- migration before this one is retried — never SQL run by hand.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "event_check_ins_one_open_per_user"
  ON "event_check_ins" ("user_id")
  WHERE "status" = 'checked_in';
