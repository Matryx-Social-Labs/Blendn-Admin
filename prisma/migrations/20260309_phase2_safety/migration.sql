-- Phase 2 fixes: safety & trust

-- Fix #14: Create blocked_users table for user blocking feature.
-- Prevents blocked users from sending message requests or DMs.
CREATE TABLE "blocked_users" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "blocker_id" TEXT        NOT NULL,
  "blocked_id" TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "blocked_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "blocked_users_blocker_id_blocked_id_key" UNIQUE ("blocker_id", "blocked_id"),
  CONSTRAINT "blocked_users_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "blocked_users_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX "blocked_users_blocker_id_idx" ON "blocked_users"("blocker_id");
CREATE INDEX "blocked_users_blocked_id_idx" ON "blocked_users"("blocked_id");

-- Fix #18: Enforce unique anonymous names per chat group at DB level.
-- Prevents race-condition duplicate names when two users join simultaneously.
ALTER TABLE "chat_group_members"
  ADD CONSTRAINT "chat_group_members_chat_group_id_anonymous_name_key"
  UNIQUE ("chat_group_id", "anonymous_name");
