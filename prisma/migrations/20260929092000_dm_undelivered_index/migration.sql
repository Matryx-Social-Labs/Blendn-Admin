-- Marking the inbox delivered looks for `delivered_at IS NULL` per conversation.
-- With only `(conversation_id)`, every inbox load walked each conversation's
-- whole history to find the few still undelivered (database review of #500).
-- A composite btree serves `conversation_id = ? AND delivered_at IS NULL`, and
-- Prisma can express it, so `migrate dev` never sees it as drift.
CREATE INDEX IF NOT EXISTS "private_messages_conversation_id_delivered_at_idx"
  ON "private_messages"("conversation_id", "delivered_at");
