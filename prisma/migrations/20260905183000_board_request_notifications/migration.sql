-- The board's two moments, so the notification centre has a category for them.
--
-- `recordNotification` refuses to write a row when the payload carries no
-- `data.type`, deliberately: a row under a guessed kind is a mislabelled line
-- in somebody's feed for ever. So a board request without these values does not
-- degrade to an uncategorised row, it produces no row at all — the ask lands
-- with no notification and no trace of why.
--
-- IF NOT EXISTS because a re-run must be a no-op; Postgres 12+ permits
-- ADD VALUE inside a transaction as long as the value is not used in the same
-- one, and nothing here uses it.
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'board_request';
ALTER TYPE "notification_kind" ADD VALUE IF NOT EXISTS 'board_request_accepted';
