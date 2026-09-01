-- Two foreign keys in the sponsors migration had no index on the REFERENCING
-- side. Postgres indexes only the referenced side, so each one turns a delete of
-- the parent into a sequential scan of the child table per parent row --
-- the same defect `chat_messages.parent_id` shipped with, which made deleting a
-- chat group effectively non-terminating once the table had volume.
--
-- A separate migration rather than an edit to 20260817011000_sponsors, because
-- that file may already have been applied to a local database and changing an
-- applied migration fails its checksum on the next deploy.
CREATE INDEX IF NOT EXISTS "sponsored_message_sends_chat_message_id_idx"
  ON "sponsored_message_sends" ("chat_message_id");

CREATE INDEX IF NOT EXISTS "upload_grants_user_id_idx"
  ON "upload_grants" ("user_id");
