-- The self-FK `private_messages.reply_to_id` needs a leading index: deleting a
-- message (an account cascade) sets its replies' reply_to_id to NULL, which
-- scans the table without one. `fk-indexes.itest.ts` holds every FK to this.
CREATE INDEX IF NOT EXISTS "private_messages_reply_to_id_idx" ON "private_messages"("reply_to_id");
