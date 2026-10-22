-- Two one-off repairs, both idempotent.
--
-- 1. A conversation with exactly ONE pseudonym null. A null pseudonym reads as
--    "this conversation never was pseudonymous" and shows that side's real name,
--    so a match opened while its room had named only one person was half real
--    names. `openConversation` now writes "Attendee" for a side the room never
--    named; this does the same for the rows already there. A conversation with
--    both null (a message request, a friend DM) is untouched.
--
-- 2. Friend requests that already exist between a pair who are still
--    pseudonymous to each other (an open conversation with a pseudonym, not
--    revealed on both sides) become HELD (friend_requests.held_at), as they
--    would have been had they been made after the hold shipped: not delivered,
--    not listed, until both reveal.
--
-- Row updates only: no table rewrite, no new lock beyond the rows touched.
BEGIN;
SET LOCAL lock_timeout = '5s';

UPDATE "private_conversations"
SET "user1_pseudonym" = COALESCE("user1_pseudonym", 'Attendee'),
    "user2_pseudonym" = COALESCE("user2_pseudonym", 'Attendee')
WHERE ("user1_pseudonym" IS NULL) <> ("user2_pseudonym" IS NULL);

UPDATE "friend_requests" fr
SET "held_at" = now()
FROM "private_conversations" pc
WHERE fr."held_at" IS NULL
  AND pc."closed_at" IS NULL
  AND (pc."user1_pseudonym" IS NOT NULL OR pc."user2_pseudonym" IS NOT NULL)
  AND NOT (pc."user1_revealed" AND pc."user2_revealed")
  AND ((pc."user1_id" = fr."sender_id" AND pc."user2_id" = fr."recipient_id")
    OR (pc."user1_id" = fr."recipient_id" AND pc."user2_id" = fr."sender_id"));

COMMIT;
