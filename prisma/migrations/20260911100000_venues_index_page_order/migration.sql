-- The admin venue index reads `WHERE deleted_at IS NULL ORDER BY owner_org_id
-- NULLS FIRST, name LIMIT 200` on every render, and `venues` is the admin table
-- that grows: every curated place is a row and none is ever removed. At 444
-- rows it is a seq scan plus a top-N sort; this index makes it an ordered
-- index scan that stops at the page boundary.
--
-- Partial, because every read of `venues` filters `deleted_at IS NULL`, and
-- Prisma cannot express a WHERE on an index -- so, like the three CHECK
-- constraints, this exists only here and only under `db:migrate`.
CREATE INDEX IF NOT EXISTS "venues_live_owner_name_idx"
  ON "venues" ("owner_org_id" ASC NULLS FIRST, "name" ASC)
  WHERE "deleted_at" IS NULL;
