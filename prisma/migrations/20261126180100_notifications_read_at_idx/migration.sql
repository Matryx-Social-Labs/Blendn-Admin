-- The retention sweep's read rule, `read_at < now() - 30 days` (SCRUM-1224, lib/notification-retention.ts). With the
-- created_at index beside it the sweep's OR is a BitmapOr of two index scans, so a batch that finds nothing reads a few
-- index pages rather than the table (EXPLAIN in the PR). The existing ("user_id", "read_at") index cannot serve it: it
-- does not lead with "read_at". Partial, because unread rows are never on this rule; so it lives here and not in
-- schema.prisma (CLAUDE.md, db push).
--
-- CONCURRENTLY, alone in its file and not wrapped, for the reasons in 20261126180000. If it fails, recovery is
-- `DROP INDEX CONCURRENTLY "notifications_read_at_idx";` in a new migration before this one is retried.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_read_at_idx" ON "notifications" ("read_at") WHERE "read_at" IS NOT NULL;
