-- How the door works, as the organiser describes it.
--
-- Informational: nothing in the API gates an RSVP on this. The venue's door is
-- what acts on it, exactly as with `min_age`. See the schema comment.

CREATE TYPE "door_policy" AS ENUM ('open', 'guest_list', 'members_only', 'invite_only');

-- NOT NULL with a default, so every existing row becomes `open` — which is
-- what they all are, and what draws no pill on the client.
ALTER TABLE "events"
  ADD COLUMN "door_policy" "door_policy" NOT NULL DEFAULT 'open';
