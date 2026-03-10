-- Migration: Add event_rsvps and event_announcements tables

-- Create rsvp_status enum
DO $$ BEGIN
  CREATE TYPE "rsvp_status" AS ENUM ('going', 'maybe', 'not_going');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create event_rsvps table
CREATE TABLE IF NOT EXISTS "event_rsvps" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "event_id"   UUID        NOT NULL,
  "user_id"    TEXT        NOT NULL,
  "status"     "rsvp_status" NOT NULL DEFAULT 'going',
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "event_rsvps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_rsvps_event_id_user_id_key" UNIQUE ("event_id", "user_id"),
  CONSTRAINT "event_rsvps_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "event_rsvps_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "event_rsvps_event_id_idx" ON "event_rsvps"("event_id");
CREATE INDEX IF NOT EXISTS "event_rsvps_user_id_idx" ON "event_rsvps"("user_id");

-- Create event_announcements table
CREATE TABLE IF NOT EXISTS "event_announcements" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "event_id"   UUID        NOT NULL,
  "content"    TEXT        NOT NULL,
  "sent_by"    TEXT        NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "event_announcements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "event_announcements_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
  CONSTRAINT "event_announcements_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "event_announcements_event_id_idx" ON "event_announcements"("event_id");
CREATE INDEX IF NOT EXISTS "event_announcements_created_at_idx" ON "event_announcements"("created_at");

-- Create audit_logs table (added for audit logging feature)
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"     TEXT,
  "action"      TEXT        NOT NULL,
  "resource"    TEXT        NOT NULL,
  "resource_id" TEXT,
  "details"     JSONB,
  "ip_address"  TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_user_id_idx" ON "audit_logs"("user_id");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_resource_idx" ON "audit_logs"("resource");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");
