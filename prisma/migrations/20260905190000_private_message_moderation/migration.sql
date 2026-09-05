-- The one channel nothing was watching.
--
-- `lib/moderation` is imported by exactly two files and both are group chat, so
-- a direct message received no keyword check, no spam check and no contact-info
-- check. `moderation_flags.message_id` is a NOT NULL foreign key to
-- `chat_messages`, which makes a flag against a DM structurally impossible —
-- so the verdict has to live on the message.
--
-- Nullable, and NULL is not "clean": DMs get the deterministic checks and no
-- model, so claiming `clean` would record an unchecked message as checked,
-- which is the exact defect G3 describes in the group pipeline.
--
-- No index. Every read of this column is already scoped by `conversation_id`,
-- which is indexed, and a conversation is tens of rows; an index on a column
-- that is NULL for almost every row would be paid for on every insert and used
-- by nothing.
ALTER TABLE "private_messages"
  ADD COLUMN IF NOT EXISTS "moderation_status" TEXT;
