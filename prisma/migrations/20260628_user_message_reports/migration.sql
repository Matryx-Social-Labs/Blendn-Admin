-- Migration: Add user_reports and message_reports tables
-- Reuses the existing "report_status" enum (pending/reviewed/resolved) already used by event_reports.

CREATE TABLE IF NOT EXISTS "user_reports" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "reporter_id" TEXT          NOT NULL,
  "reported_id" TEXT          NOT NULL,
  "reason"      TEXT          NOT NULL,
  "description" TEXT,
  "status"      "report_status" NOT NULL DEFAULT 'pending',
  "created_at"  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "user_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "User"("id") ON DELETE CASCADE,
  CONSTRAINT "user_reports_reported_id_fkey" FOREIGN KEY ("reported_id") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "user_reports_reported_id_idx" ON "user_reports"("reported_id");
CREATE INDEX IF NOT EXISTS "user_reports_status_idx" ON "user_reports"("status");

CREATE TABLE IF NOT EXISTS "message_reports" (
  "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
  "reporter_id"  TEXT          NOT NULL,
  "message_id"   UUID          NOT NULL,
  "message_type" TEXT          NOT NULL,
  "reason"       TEXT          NOT NULL,
  "description"  TEXT,
  "status"       "report_status" NOT NULL DEFAULT 'pending',
  "created_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT "message_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "message_reports_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "User"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "message_reports_message_id_idx" ON "message_reports"("message_id");
CREATE INDEX IF NOT EXISTS "message_reports_status_idx" ON "message_reports"("status");
