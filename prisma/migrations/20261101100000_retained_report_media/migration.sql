-- SCRUM-955 (owner row A-24): a pointer to a reported image the 180-day purge left. Nothing else of the person.
BEGIN;
CREATE TABLE IF NOT EXISTS "retained_report_media" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "object_key" TEXT NOT NULL,
  "message_id" UUID NOT NULL,
  "message_type" TEXT NOT NULL,
  "erase_by" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "retained_report_media_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "retained_report_media_object_key_key" ON "retained_report_media"("object_key");
CREATE INDEX IF NOT EXISTS "retained_report_media_erase_by_idx" ON "retained_report_media"("erase_by");
COMMIT;
