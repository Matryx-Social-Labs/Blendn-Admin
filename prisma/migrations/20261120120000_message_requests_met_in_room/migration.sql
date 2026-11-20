-- "Met in the Lobby · Your ride" (Flow 5 C5 · B-A): a message request sent from a Lobby (board post) room's handle
-- keeps which room, as `met_in_event_id` keeps an event room's. A key, not a snapshot: a board post's room is never
-- deleted (`chat_groups.board_post_id` is ON DELETE RESTRICT), and SET NULL covers the rest.
-- Additive: a nullable column with no default (no rewrite; every existing row reads null) and its FK index.
-- Wrapped, because `migrate deploy` is not transactional; the ALTERs take a brief lock on a small table, and the
-- index is built in the same transaction on a column that is null everywhere.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "message_requests" ADD COLUMN "met_in_room_id" UUID;
ALTER TABLE "message_requests"
  ADD CONSTRAINT "message_requests_met_in_room_id_fkey"
  FOREIGN KEY ("met_in_room_id") REFERENCES "chat_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "message_requests_met_in_room_id_idx" ON "message_requests"("met_in_room_id");

COMMIT;
