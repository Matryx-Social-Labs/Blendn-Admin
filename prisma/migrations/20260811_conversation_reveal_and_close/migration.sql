-- Identity and ending, on the conversation itself.
--
-- Seven columns in one migration deliberately: the reveal half (Stage 3a) and
-- the close half (Stage 6) both land on private_conversations, and two
-- migrations against the same table is two deploys of risk for no benefit. The
-- reveal columns are unused until the reveal PR; they are additive and default
-- to the safe value, so shipping them early costs nothing.
--
-- All additive, all defaulted or nullable. No backfill: every existing row is
-- live (closed_at NULL) and unrevealed, which is exactly what the defaults say.

ALTER TABLE "private_conversations"
  ADD COLUMN IF NOT EXISTS "user1_revealed"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "user2_revealed"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "user1_pseudonym"        TEXT,
  ADD COLUMN IF NOT EXISTS "user2_pseudonym"        TEXT,
  ADD COLUMN IF NOT EXISTS "user1_reveal_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "user2_reveal_requested" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "origin_event_id"        UUID,
  ADD COLUMN IF NOT EXISTS "closed_at"              TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "closed_by"              TEXT,
  ADD COLUMN IF NOT EXISTS "closed_reason"          TEXT;

-- Every inbox read is "my live conversations". Partial on closed_at IS NULL
-- would be tighter, but Prisma cannot express it and the composite serves the
-- same query shape.
CREATE INDEX IF NOT EXISTS "private_conversations_user1_id_closed_at_idx"
  ON "private_conversations" ("user1_id", "closed_at");
CREATE INDEX IF NOT EXISTS "private_conversations_user2_id_closed_at_idx"
  ON "private_conversations" ("user2_id", "closed_at");
