-- Baseline: the schema as it stood before the first migration.
--
-- WHY THIS EXISTS
--
-- `prisma migrate deploy` failed on any clean database. The chain began with
-- `20260309_phase1_fixes`, which opens `ALTER TABLE "profiles" DROP COLUMN ...`
-- and `UPDATE "User" ... FROM profiles` -- so it assumed a database that
-- already had a schema. It did: the project created one with `db push` and
-- started writing migrations on top of it, and no migration ever created the
-- base tables.
--
-- The consequence was invisible in every environment that mattered. Production
-- and staging were `db push`-ed once and have replayed migrations happily ever
-- since; CI worked around it with `db push` too. Only a genuinely new database
-- hit it -- which is to say, a disaster recovery, a new region, or a developer
-- on their first day.
--
-- HOW IT WAS BUILT
--
-- Not hand-written. `prisma migrate diff --from-empty --to-schema` against
-- `prisma/schema.prisma` as it stood at df059e86, the commit before the one
-- that added the first migration. So it reproduces exactly the shape those 52
-- migrations were authored against, and they replay onto it in order.
--
-- WHY EVERY STATEMENT IS IDEMPOTENT
--
-- This has to be a no-op on databases that already exist. Production and
-- staging have `_prisma_migrations` rows for the 52 but none for this file, so
-- `migrate deploy` will run it there exactly once, against a database that
-- already has all 29 tables.
--
-- `CREATE TABLE`/`INDEX` take `IF NOT EXISTS`. `CREATE TYPE` and
-- `ADD CONSTRAINT` do not, so they catch `duplicate_object` instead. The
-- alternative was `migrate resolve --applied` run by hand against each
-- environment, and a migration state that depends on somebody remembering a
-- manual step is the failure mode this repo already has a memory note about.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "user_role" AS ENUM ('app_admin', 'organizer', 'venue_owner', 'attendee');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "event_status" AS ENUM ('draft', 'published', 'cancelled', 'completed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "visibility_type" AS ENUM ('public', 'private', 'unlisted');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "media_type" AS ENUM ('image', 'video', 'document');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "check_in_status" AS ENUM ('pending', 'checked_in', 'checked_out', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "chat_group_type" AS ENUM ('event', 'private', 'announcement');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "chat_group_status" AS ENUM ('active', 'archived', 'locked');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "message_type" AS ENUM ('text', 'image', 'video', 'system', 'sponsored', 'announcement');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "member_role" AS ENUM ('member', 'moderator', 'admin');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "member_status" AS ENUM ('active', 'muted', 'banned');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "report_status" AS ENUM ('pending', 'reviewed', 'resolved');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateEnum
DO $$ BEGIN
    CREATE TYPE "message_request_status" AS ENUM ('pending', 'accepted', 'declined', 'blocked');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "password" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'attendee',

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "profiles" (
    "id" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT,
    "age" INTEGER,
    "location" TEXT,
    "bio" TEXT,
    "occupation" TEXT,
    "education" TEXT,
    "interests" TEXT[],
    "photos" TEXT[],
    "onboarded" BOOLEAN NOT NULL DEFAULT false,
    -- `push_token` / `push_platform` deliberately absent: `20260309_phase1_fixes`
    -- drops them, since every push token lives in `push_tokens`. Same reasoning
    -- as the index note further down — creating them here resurrects two dead
    -- columns on any database where that migration has already run.
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "events" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "short_description" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "address" TEXT,
    "venue_name" TEXT,
    "city" TEXT,
    "state" TEXT,
    "country" TEXT,
    "postal_code" TEXT,
    "start_time" TIMESTAMPTZ(6) NOT NULL,
    "end_time" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "event_status" NOT NULL DEFAULT 'draft',
    "visibility" "visibility_type" NOT NULL DEFAULT 'public',
    "max_capacity" INTEGER,
    "current_capacity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "organizer_id" TEXT NOT NULL,
    "cover_image_url" TEXT,
    "external_link" TEXT,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "check_in_radius" DOUBLE PRECISION NOT NULL DEFAULT 30,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_details" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "full_description" TEXT NOT NULL,
    "house_rules" TEXT,
    "cancellation_policy" TEXT,
    "additional_info" JSONB,
    "faq" JSONB,
    "accessibility_info" JSONB,
    "covid_guidelines" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_details_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "parent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_categories" (
    "event_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_categories_pkey" PRIMARY KEY ("event_id","category_id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_media" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "type" "media_type" NOT NULL,
    "url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "title" TEXT,
    "description" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_check_ins" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "check_in_status" NOT NULL DEFAULT 'pending',
    "check_in_time" TIMESTAMPTZ(6),
    "check_out_time" TIMESTAMPTZ(6),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "device_info" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_groups" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "type" "chat_group_type" NOT NULL DEFAULT 'event',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" TEXT,
    "status" "chat_group_status" NOT NULL DEFAULT 'active',
    "member_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "chat_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_messages" (
    "id" UUID NOT NULL,
    "chat_group_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "parent_id" UUID,
    "type" "message_type" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMPTZ(6),
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by" TEXT,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "chat_group_members" (
    "id" UUID NOT NULL,
    "chat_group_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'member',
    "status" "member_status" NOT NULL DEFAULT 'active',
    "anonymous_name" TEXT,
    "last_read_message_id" UUID,
    "last_allowed_at" TIMESTAMPTZ(6),
    "notification_preferences" JSONB NOT NULL DEFAULT '{}',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "banned_at" TIMESTAMPTZ(6),
    "banned_by" TEXT,

    CONSTRAINT "chat_group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "message_reactions" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_favorites" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_ratings" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_reports" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "description" TEXT,
    "status" "report_status" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- CreateTable
CREATE TABLE IF NOT EXISTS "mobile_refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_info" JSONB,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "mobile_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_interests" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "push_tokens" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "private_conversations" (
    "id" UUID NOT NULL,
    "user1_id" TEXT NOT NULL,
    "user2_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_at" TIMESTAMPTZ(6),

    CONSTRAINT "private_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "private_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "sender_id" TEXT NOT NULL,
    "message_text" TEXT,
    "media_url" TEXT,
    "media_type" "media_type",
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "private_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_sponsored_messages" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "last_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_sponsored_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "event_announcements" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "sent_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" TEXT,
    "details" JSONB,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "message_requests" (
    "id" UUID NOT NULL,
    "sender_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "status" "message_request_status" NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ(6),

    CONSTRAINT "message_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "events_slug_key" ON "events"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_latitude_longitude_idx" ON "events"("latitude", "longitude");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_status_start_time_idx" ON "events"("status", "start_time");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_organizer_id_idx" ON "events"("organizer_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_deleted_at_idx" ON "events"("deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_city_idx" ON "events"("city");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_is_featured_idx" ON "events"("is_featured");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "events_start_time_idx" ON "events"("start_time");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "event_details_event_id_key" ON "event_details"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "categories_parent_id_idx" ON "categories"("parent_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_categories_category_id_idx" ON "event_categories"("category_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_media_event_id_order_idx" ON "event_media"("event_id", "order");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_check_ins_event_id_status_idx" ON "event_check_ins"("event_id", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_check_ins_user_id_idx" ON "event_check_ins"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_check_ins_user_id_status_idx" ON "event_check_ins"("user_id", "status");

-- DELIBERATELY NOT CREATED: "event_check_ins_event_id_user_id_key".
--
-- `20260807_event_occurrences` drops this unique and replaces it with one on
-- (occurrence_id, user_id), because a multi-day event needs a row per person
-- per DAY. Creating it here was harmless on a fresh install — the later
-- migration dropped it moments after — and destructive on an existing database,
-- where that migration ran months ago and will not run again.
--
-- The baseline is pending on every deployed environment, so it applies AFTER
-- the migrations that came chronologically later. Re-creating this index would
-- have made a second-day check-in violate a unique constraint: multi-day
-- attendance, silently impossible, on the mechanic the product is built on.
--
-- Verified against a copy of staging: replaying the chain reintroduced it.
-- Nothing in the schema wants it, so it is not created at all.

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "chat_groups_event_id_key" ON "chat_groups"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_groups_status_idx" ON "chat_groups"("status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_chat_group_id_created_at_idx" ON "chat_messages"("chat_group_id", "created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_chat_group_id_deleted_at_idx" ON "chat_messages"("chat_group_id", "deleted_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_messages_user_id_idx" ON "chat_messages"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_group_members_user_id_idx" ON "chat_group_members"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "chat_group_members_user_id_status_idx" ON "chat_group_members"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "chat_group_members_chat_group_id_user_id_key" ON "chat_group_members"("chat_group_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_message_id_user_id_emoji_key" ON "message_reactions"("message_id", "user_id", "emoji");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_favorites_user_id_idx" ON "event_favorites"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_favorites_event_id_idx" ON "event_favorites"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "event_favorites_event_id_user_id_key" ON "event_favorites"("event_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_ratings_event_id_idx" ON "event_ratings"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "event_ratings_event_id_user_id_key" ON "event_ratings"("event_id", "user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_reports_event_id_idx" ON "event_reports"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_reports_status_idx" ON "event_reports"("status");

-- CreateIndex
-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_refresh_tokens_token_hash_key" ON "mobile_refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mobile_refresh_tokens_user_id_idx" ON "mobile_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "mobile_refresh_tokens_expires_at_idx" ON "mobile_refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_interests_user_id_category_id_key" ON "user_interests"("user_id", "category_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_oauth_accounts_user_id_idx" ON "user_oauth_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_oauth_accounts_provider_provider_id_key" ON "user_oauth_accounts"("provider", "provider_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "push_tokens_user_id_idx" ON "push_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_user_id_token_key" ON "push_tokens"("user_id", "token");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_conversations_user1_id_idx" ON "private_conversations"("user1_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_conversations_user2_id_idx" ON "private_conversations"("user2_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_conversations_last_message_at_idx" ON "private_conversations"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "private_conversations_user1_id_user2_id_key" ON "private_conversations"("user1_id", "user2_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_messages_conversation_id_idx" ON "private_messages"("conversation_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_messages_sender_id_idx" ON "private_messages"("sender_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "private_messages_created_at_idx" ON "private_messages"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_sponsored_messages_event_id_idx" ON "event_sponsored_messages"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_sponsored_messages_is_active_idx" ON "event_sponsored_messages"("is_active");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_announcements_event_id_idx" ON "event_announcements"("event_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "event_announcements_created_at_idx" ON "event_announcements"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_resource_idx" ON "audit_logs"("resource");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "message_requests_recipient_id_status_idx" ON "message_requests"("recipient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "message_requests_sender_id_recipient_id_key" ON "message_requests"("sender_id", "recipient_id");

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_details" ADD CONSTRAINT "event_details_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_media" ADD CONSTRAINT "event_media_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_check_ins" ADD CONSTRAINT "event_check_ins_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_check_ins" ADD CONSTRAINT "event_check_ins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_groups" ADD CONSTRAINT "chat_groups_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_group_id_fkey" FOREIGN KEY ("chat_group_id") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_group_members" ADD CONSTRAINT "chat_group_members_chat_group_id_fkey" FOREIGN KEY ("chat_group_id") REFERENCES "chat_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "chat_group_members" ADD CONSTRAINT "chat_group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_favorites" ADD CONSTRAINT "event_favorites_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_favorites" ADD CONSTRAINT "event_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_ratings" ADD CONSTRAINT "event_ratings_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_ratings" ADD CONSTRAINT "event_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_reports" ADD CONSTRAINT "event_reports_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_reports" ADD CONSTRAINT "event_reports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "mobile_refresh_tokens" ADD CONSTRAINT "mobile_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "user_oauth_accounts" ADD CONSTRAINT "user_oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "private_conversations" ADD CONSTRAINT "private_conversations_user1_id_fkey" FOREIGN KEY ("user1_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "private_conversations" ADD CONSTRAINT "private_conversations_user2_id_fkey" FOREIGN KEY ("user2_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "private_messages" ADD CONSTRAINT "private_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "private_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "private_messages" ADD CONSTRAINT "private_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_sponsored_messages" ADD CONSTRAINT "event_sponsored_messages_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_announcements" ADD CONSTRAINT "event_announcements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "event_announcements" ADD CONSTRAINT "event_announcements_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- AddForeignKey
DO $$ BEGIN
    ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;


-- `recurring_events` is deliberately NOT created here.
--
-- It existed in the March 2026 schema this baseline reproduces, and
-- `20260807_event_occurrences` drops it with `DROP TABLE IF EXISTS` -- so on a
-- fresh database creating it here would only mean creating it to delete it.
--
-- On production and staging that drop has already run, and this baseline has
-- not. Creating the table here would therefore *resurrect* it there: an empty,
-- unreferenced table reappearing in a schema that no longer declares it, which
-- is drift introduced by the very migration meant to remove drift. Measured
-- against a production-shaped database before this line was added -- seven
-- columns of `recurring_events` came back.
--
-- Omitting it is safe in both directions because the later drop tolerates a
-- table that was never there.
