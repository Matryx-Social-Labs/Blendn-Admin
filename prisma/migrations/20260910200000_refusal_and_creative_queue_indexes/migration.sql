-- Two queues that scan the whole table on every admin overview render.
--
-- `refusalsByReason` filters `check_in_refusals` on `created_at` ALONE, and the
-- only date-bearing index on that table leads with `event_id` — so the leading
-- column is unconstrained and Postgres cannot seek it. `event_check_ins`
-- already carries a bare `check_in_time` index for exactly this reason; the
-- same gap reappeared one table later, on a query added the same week.
CREATE INDEX IF NOT EXISTS "check_in_refusals_created_at_idx"
  ON "check_in_refusals" ("created_at");

-- `attentionQueues()` reads eight tables the same way: pending rows, oldest
-- first. Seven of them have at least a bare status index and three have this
-- exact pair. `sponsored_creatives` had none, so the one queue whose SLA is
-- commercial rather than safety was the only one sequential-scanning.
CREATE INDEX IF NOT EXISTS "sponsored_creatives_moderation_status_created_at_idx"
  ON "sponsored_creatives" ("moderation_status", "created_at");
