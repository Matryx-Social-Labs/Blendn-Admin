-- The contract half of an expand/contract, now due.
--
-- `event_check_ins.intent` and `.revealed` stopped being read or written in
-- 0.65.0, when `event_match_preferences` took over. They were kept one release
-- so a rollback had somewhere to land: dropping a column in the same deploy
-- that stops using it means the previous build cannot run at all. We are four
-- releases past that, so the rollback they were protecting no longer exists.
--
-- Why they had to move rather than be fixed in place: a check-in is keyed
-- `(occurrence_id, user_id)`, so a five-day conference gives one person five
-- rows. Both readers used `findFirst({ event_id, user_id })` with no ordering,
-- so which day's answer you got was whatever Postgres returned first.
-- `event_match_preferences` is one row per person per event, which is what
-- "per event" always meant.
--
-- Verified before writing this: the fields were removed from schema.prisma and
-- `tsc --noEmit` passed clean. Prisma's types are generated from the schema, so
-- any surviving reader is a compile error rather than something grep might miss.

ALTER TABLE "event_check_ins" DROP COLUMN IF EXISTS "intent";
ALTER TABLE "event_check_ins" DROP COLUMN IF EXISTS "revealed";
