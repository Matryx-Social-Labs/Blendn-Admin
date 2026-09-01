-- Catch-up: the moderation objects no migration ever created.
--
-- `moderation_flags`, `moderation_source` and `moderation_status_type` are in
-- `schema.prisma` and are read by the moderation pipeline every time a message
-- is posted -- and **no migration creates any of them**. They were added with
-- `db push` and never written down.
--
-- The first migration to reference one is `20260817011000_sponsors`, which
-- declares a column of type `moderation_status_type`. On a database built by
-- replaying migrations that failed with `type "moderation_status_type" does
-- not exist`; on production and staging the type had been pushed long before,
-- so the reference resolved and nobody learned otherwise.
--
-- Placed here rather than in the baseline because `moderation_flags` has
-- foreign keys to `chat_messages` and `User`, so it has to land after those
-- exist. Dated to sit immediately before the migration that first needs it.
--
-- Idempotent throughout, for the same reason as the baseline: production and
-- staging already have all three, and will run this once.

DO $$ BEGIN
    CREATE TYPE "moderation_source" AS ENUM ('auto_text', 'auto_image', 'auto_spam', 'auto_keyword', 'user_report', 'manual');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    CREATE TYPE "moderation_status_type" AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "moderation_flags" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "chat_group_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" "moderation_source" NOT NULL,
    "status" "moderation_status_type" NOT NULL DEFAULT 'pending',
    "categories" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "auto_action" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moderation_flags_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "moderation_flags_status_created_at_idx" ON "moderation_flags"("status", "created_at");

CREATE INDEX IF NOT EXISTS "moderation_flags_chat_group_id_idx" ON "moderation_flags"("chat_group_id");

CREATE INDEX IF NOT EXISTS "moderation_flags_user_id_idx" ON "moderation_flags"("user_id");

CREATE INDEX IF NOT EXISTS "moderation_flags_message_id_idx" ON "moderation_flags"("message_id");

DO $$ BEGIN
    ALTER TABLE "moderation_flags" ADD CONSTRAINT "moderation_flags_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
    ALTER TABLE "moderation_flags" ADD CONSTRAINT "moderation_flags_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;