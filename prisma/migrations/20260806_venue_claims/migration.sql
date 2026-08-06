-- Venue claims.
--
-- Owning a venue record means operational control over OTHER PEOPLE'S events
-- held there — an organiser picking a claimed venue auto-links immediately, and
-- the owner then gets the chatroom, moderation and attendee list. So a claim is
-- an access request, not data entry, and a false one is an access-control
-- failure rather than a data-quality one.
--
-- Nothing in the evidence can be verified automatically. GSTIN is checksum-only
-- (see lib/gstin.ts, which says so plainly), and a trade licence is a PDF. A
-- person decides, in the same queue shape as organiser onboarding.
--
-- A claim against a venue that already has an owner is a dispute: the incumbent
-- is notified and an admin weighs both sides.

CREATE TYPE "venue_claim_status" AS ENUM ('pending', 'approved', 'declined');

CREATE TABLE "venue_claims" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id"      UUID NOT NULL,
    "org_id"        UUID NOT NULL,
    "filed_by"      TEXT NOT NULL,
    "status"        "venue_claim_status" NOT NULL DEFAULT 'pending',
    "is_dispute"    BOOLEAN NOT NULL DEFAULT false,
    "gstin"         TEXT,
    "evidence"      JSONB,
    "reviewed_by"   TEXT,
    "reviewed_at"   TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "venue_claims_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "venue_claims" ADD CONSTRAINT "venue_claims_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "venue_claims" ADD CONSTRAINT "venue_claims_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live claim per org per venue: re-filing after a decline updates the row
-- rather than stacking duplicates for a reviewer to wade through.
CREATE UNIQUE INDEX "venue_claims_venue_id_org_id_key" ON "venue_claims"("venue_id", "org_id");
CREATE INDEX "venue_claims_status_idx" ON "venue_claims"("status");
CREATE INDEX "venue_claims_venue_id_idx" ON "venue_claims"("venue_id");
-- Both FKs indexed; an unindexed one is a seq scan on every parent delete.
CREATE INDEX "venue_claims_org_id_idx" ON "venue_claims"("org_id");
