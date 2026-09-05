-- Where a conversation came from, stated rather than inferred.
--
-- `cameFromMatch` decided provenance by asking whether either pseudonym was
-- set: a match snapshots both, a message-request conversation snapshots
-- neither. That works for exactly two origins.
--
-- A board conversation is pseudonymous as well — it must be, because
-- `displayNameInConversation` falls back to the real name when there is no
-- pseudonym — so the inference would have called it a match, and the client
-- draws a match opener on anything it calls a match.
--
-- No foreign key, deliberately. A board request is deleted when its author
-- deletes their account, and a conversation that has real messages in it must
-- not cascade away with the ask that started it. The column is provenance, not
-- a live relation.
ALTER TABLE "private_conversations"
  ADD COLUMN IF NOT EXISTS "origin_board_request_id" UUID;
