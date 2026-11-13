-- The Live tab's "Meeting tonight" counts the private chats a room opened, once
-- a minute per watched event, by `origin_event_id` and by the Lobby ask that
-- opened them (SCRUM-1051). Neither column had an index, so each read was a
-- scan of every conversation. Additive; no row changes.
-- Wrapped: `migrate deploy` is not transactional, and a half-applied file blocks every later deploy.
-- CREATE INDEX holds a SHARE lock on "private_conversations" (writes wait) while it builds;
-- the table is small, and lock_timeout fails a queued deploy fast rather than stalling chats.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX "private_conversations_origin_event_id_idx" ON "private_conversations"("origin_event_id");
CREATE INDEX "private_conversations_origin_board_request_id_idx" ON "private_conversations"("origin_board_request_id");

COMMIT;
