-- SCRUM-1026: the Lobby's two opt-in pushes. Their own migration, because a new enum value cannot be
-- used in the transaction that adds it. Push only (NOT_IN_THE_BELL), so no row is ever written with
-- them; the values exist because `notification_kind` and `NotificationData["type"]` are one list.
BEGIN;
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'board_match';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'board_host_post';
COMMIT;
