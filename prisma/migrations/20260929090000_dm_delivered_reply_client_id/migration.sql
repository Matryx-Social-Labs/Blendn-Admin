-- Delivered ticks, DM replies, and idempotent sends (SCRUM-408, SCRUM-409, SCRUM-410).
-- Additive only: nullable columns and indexes, nothing dropped or backfilled,
-- so it is safe under Railway's pre-deploy `prisma migrate deploy`.

-- When the recipient's app received the message (socket ack, or loading the
-- thread or the inbox). Null until then; a sender sees ✓ until it is set.
ALTER TABLE "private_messages" ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(6);

-- The message this one replies to, in the same conversation. SET NULL keeps a
-- reply readable if its quote is ever removed with an account.
ALTER TABLE "private_messages" ADD COLUMN IF NOT EXISTS "reply_to_id" UUID;
DO $$ BEGIN
  ALTER TABLE "private_messages" ADD CONSTRAINT "private_messages_reply_to_id_fkey"
    FOREIGN KEY ("reply_to_id") REFERENCES "private_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The sender's own id for a send, so a retry after a lost response returns the
-- row it already wrote instead of writing a second. NULLs stay distinct, so
-- every send made before this column existed is unaffected.
ALTER TABLE "private_messages" ADD COLUMN IF NOT EXISTS "client_id" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "private_messages_sender_id_client_id_key"
  ON "private_messages"("sender_id", "client_id");

ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "client_id" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_user_id_client_id_key"
  ON "chat_messages"("user_id", "client_id");
