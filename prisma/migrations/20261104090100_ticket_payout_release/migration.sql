-- SCRUM-1014, security review 5. Route transfers are created on_hold with no on_hold_until: Razorpay never
-- releases on its own, and the release job (lib/payout-release.ts) releases a payout once its event's current
-- holdFloor (the later of start and end, + 3 days) has passed. on_hold_until is dead: the hold is a status.
BEGIN;

ALTER TABLE "ticket_payouts"
  ADD COLUMN "releasing_at" TIMESTAMPTZ(6),
  ADD COLUMN "released_at" TIMESTAMPTZ(6),
  DROP COLUMN "on_hold_until";

-- Money moved only with Razorpay's transfer id; releasing and released say when.
ALTER TABLE "ticket_payouts" DROP CONSTRAINT "ticket_payouts_status_shape";
ALTER TABLE "ticket_payouts" ADD CONSTRAINT "ticket_payouts_status_shape" CHECK (
  CASE "status"
    WHEN 'pending' THEN "linked_account_ref" IS NOT NULL AND "provider_transfer_ref" IS NULL
    WHEN 'on_hold' THEN "linked_account_ref" IS NOT NULL AND "provider_transfer_ref" IS NOT NULL
    WHEN 'releasing' THEN "provider_transfer_ref" IS NOT NULL AND "releasing_at" IS NOT NULL
    WHEN 'released' THEN "provider_transfer_ref" IS NOT NULL AND "released_at" IS NOT NULL
    WHEN 'no_account' THEN "linked_account_ref" IS NULL AND "provider_transfer_ref" IS NULL
    ELSE TRUE
  END
);

-- The release job's list: held payouts, and claims to retry.
CREATE INDEX "ticket_payouts_held" ON "ticket_payouts"("status") WHERE "status" IN ('on_hold', 'releasing');

COMMIT;
