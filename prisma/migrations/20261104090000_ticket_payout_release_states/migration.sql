-- SCRUM-1014, security review 5: we are the only releaser of a payout. Two new states, in their own
-- migration because a new enum value cannot be used in the transaction that adds it.
--   releasing   claimed by the release job; Razorpay is being told to release (or was, and we did not hear)
--   released    Razorpay released it (on_hold false): the organizer's money has left the hold
BEGIN;
ALTER TYPE "ticket_payout_status" ADD VALUE IF NOT EXISTS 'releasing';
ALTER TYPE "ticket_payout_status" ADD VALUE IF NOT EXISTS 'released';
COMMIT;
