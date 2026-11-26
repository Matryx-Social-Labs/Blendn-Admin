-- The retention sweep's unread rule, `read_at IS NULL AND created_at < now() - 90 days` (SCRUM-1224, lib/notification-retention.ts).
-- Before this, no index on "notifications" led with "created_at", so every batch of the sweep scanned the whole table.
-- Also `@@index([created_at])` in schema.prisma, so a db push database has it too.
--
-- CONCURRENTLY, alone in its file and not wrapped: it cannot run inside a transaction, and a plain CREATE INDEX would
-- hold every bell write in the product for the length of a scan of the whole table. If it fails it leaves an INVALID
-- index behind; IF NOT EXISTS would then skip it, so recovery is
-- `DROP INDEX CONCURRENTLY "notifications_created_at_idx";` in a new migration before this one is retried, never SQL
-- run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_created_at_idx" ON "notifications" ("created_at");
