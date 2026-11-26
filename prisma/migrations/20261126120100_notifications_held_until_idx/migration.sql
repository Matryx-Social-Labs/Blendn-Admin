-- What the 09:00 release reads (SCRUM-1276): held rows only, a few per person a night, so the index stays tiny
-- however large "notifications" grows. Partial, so it lives here and not in schema.prisma (CLAUDE.md, db push).
--
-- CONCURRENTLY, alone in its file and not wrapped: it cannot run inside a transaction, and a plain CREATE INDEX would
-- hold every bell write in the product for the length of a scan of the whole table. If it fails it leaves an INVALID
-- index behind; IF NOT EXISTS would then skip it, so recovery is
-- `DROP INDEX CONCURRENTLY "notifications_held_until_idx";` in a new migration before this one is retried, never SQL
-- run by hand.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "notifications_held_until_idx" ON "notifications" ("held_until") WHERE "held_until" IS NOT NULL;
