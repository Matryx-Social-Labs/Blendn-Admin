-- The CHECK that a deployed environment never got.
--
-- `20260309_phase1_fixes` adds `events_capacity_non_negative`, and staging has
-- that migration recorded and does not have the constraint. Production does
-- have it, so this is environment drift rather than a broken migration: the
-- most likely history is a `db push` that rebuilt the table without it, since
-- `schema.prisma` cannot express a CHECK and `db push` therefore creates none.
--
-- That is the exact hazard CLAUDE.md documents — a pushed database is strictly
-- weaker than production, and a comparison by columns alone does not show it.
-- Here it cost the constraint that stops `current_capacity` going negative,
-- which is a counter three surfaces still render.
--
-- Idempotent and safe to re-run: a no-op on production and on any fresh
-- install, where `phase1_fixes` already created it. Verified against staging
-- before writing: 39 events, 0 rows violating, minimum 0 — so adding it cannot
-- fail on existing data, which is the way an ALTER ... ADD CHECK kills a deploy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'public'
      AND c.conname = 'events_capacity_non_negative'
  ) THEN
    ALTER TABLE "events"
      ADD CONSTRAINT "events_capacity_non_negative" CHECK ("current_capacity" >= 0);
  END IF;
END $$;
