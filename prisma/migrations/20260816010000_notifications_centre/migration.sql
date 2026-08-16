-- The notifications centre — one line per per-user notification.
--
-- Written by `sendPushNotification`, before the token lookup, so the row
-- survives all three ways a push does not arrive: notifications turned off in
-- settings, no device registered, and an expired token. That is the whole point
-- of a centre — it is where you look for what you missed.

-- Mirrors `NotificationData["type"]` in `lib/push-notifications.ts` exactly.
-- `__tests__/notifications.test.ts` fails if the two lists stop agreeing,
-- because a kind the sender emits and the enum does not accept is a write that
-- throws inside a fire-and-forget `.catch(() => {})` and disappears.
CREATE TYPE "notification_kind" AS ENUM (
  'private_message',
  'group_message',
  'event_checkin',
  'event_update',
  'announcement',
  'message_request',
  'message_request_response',
  'waitlist_promoted',
  'match',
  'reveal_request',
  'reveal'
);

CREATE TABLE "notifications" (
  "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    TEXT NOT NULL,
  "kind"       "notification_kind" NOT NULL,
  "title"      TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  -- The same `data` payload the push carries, so the app has one deep-link
  -- switch rather than two that can disagree.
  "data"       JSONB,
  -- Null until read. A timestamp rather than a boolean because "when did they
  -- see this" is what the retention report will ask, and a boolean cannot be
  -- turned back into a time.
  "read_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- The feed: one person's notifications, newest first.
CREATE INDEX "notifications_user_id_created_at_idx"
  ON "notifications" ("user_id", "created_at");

-- The unread count, which the bell asks for on every screen.
CREATE INDEX "notifications_user_id_read_at_idx"
  ON "notifications" ("user_id", "read_at");

-- Cascade, so account deletion takes the history with it rather than leaving
-- orphaned rows that still carry a title and a body.
-- `"User"`, capitalised and singular: the NextAuth model has no `@@map`, so
-- Prisma names the table after the model. Every other migration in this repo
-- references it the same way.
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
