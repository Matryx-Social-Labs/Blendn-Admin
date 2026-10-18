-- A DM thread is read "this conversation, newest first" and "this conversation,
-- oldest unread". Staging plans: the history was a Bitmap Index Scan on
-- private_messages_conversation_id_idx that read the whole thread and then
-- sorted it top-N; the first-unread lookup in lib/dm-thread.ts was an Index
-- Scan on private_messages_created_at_idx with `Rows Removed by Filter: 520`,
-- walking other people's messages, on every DM open. (conversation_id,
-- created_at) serves both in order; it also serves everything the old
-- single-column index did, so that one goes.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX "private_messages_conversation_id_created_at_idx" ON "private_messages"("conversation_id", "created_at");
DROP INDEX IF EXISTS "private_messages_conversation_id_idx";

COMMIT;
