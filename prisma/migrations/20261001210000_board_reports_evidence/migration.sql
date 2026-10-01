-- Board reports keep their evidence, and one reporter files one (SCRUM-322 review).
--
-- 1. The words as they were when reported. A board post can be withdrawn and an
--    erased account's ask loses its message; the report should still say what
--    was reported.
ALTER TABLE "message_reports" ADD COLUMN "excerpt" TEXT;

-- 2. One pending report per reporter per board post or ask. Without it one
--    account could stack the queue — which shows the oldest 100 — with the same
--    report and bury everybody else's. Scoped to the board's types: the room and
--    DM report routes have no duplicate handling, and a constraint they did not
--    expect would turn a second tap there into a 500. Checked read-only on
--    2026-10-01: staging and production had 0 duplicate pending reports of any
--    type, so this builds cleanly.
CREATE UNIQUE INDEX "message_reports_one_pending_board"
  ON "message_reports"("reporter_id", "message_type", "message_id")
  WHERE "status" = 'pending' AND "message_type" IN ('board_post', 'board_request');
