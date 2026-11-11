-- Flow 5 · B-A (SCRUM-1042): where two people met, on the message request ("Met in the room at …").
-- Additive only: a nullable column with no default (metadata-only, no rewrite), its index and its foreign key.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- lock_timeout so a queued ALTER on message_requests fails fast rather than stalling the inbox.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "message_requests" ADD COLUMN "met_in_event_id" UUID;
CREATE INDEX "message_requests_met_in_event_id_idx" ON "message_requests"("met_in_event_id");
ALTER TABLE "message_requests" ADD CONSTRAINT "message_requests_met_in_event_id_fkey"
  FOREIGN KEY ("met_in_event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
