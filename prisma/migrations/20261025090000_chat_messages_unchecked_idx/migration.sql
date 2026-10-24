-- The re-check sweeper (lib/moderation-recheck.ts) reads room messages whose
-- text OpenAI could not check: `moderation_status = 'unchecked'`, oldest first.
-- Nothing served that: chat_messages is indexed by room, not by status. A
-- PARTIAL index holds only the few unchecked rows, so the sweeper's every-minute
-- read is an index walk however large the table is, and rows leave it as they
-- are settled.
--
-- schema.prisma cannot express a partial index, so this exists only in
-- migration SQL (as event_check_ins_one_open_per_user does).
--
-- CONCURRENTLY, alone in its file and not wrapped in BEGIN/COMMIT: a plain
-- CREATE INDEX would hold writes on chat_messages (every send in the product)
-- for the length of the build, and Postgres refuses CONCURRENTLY inside a
-- transaction (__tests__/migration-tx.test.ts allows exactly this shape). If it
-- fails it leaves an INVALID index behind and IF NOT EXISTS would then skip it,
-- so recovery is `DROP INDEX CONCURRENTLY "chat_messages_unchecked_idx";` in a
-- new migration before this one is retried -- never SQL run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_messages_unchecked_idx"
  ON "chat_messages" ("created_at")
  WHERE "moderation_status" = 'unchecked' AND "deleted_at" IS NULL;
