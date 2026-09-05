-- Verifying a domain by emailing a role address.
--
-- Only the DNS TXT path was ever wired: `claimDomain` hardcodes `dns_txt`,
-- `isRoleAddressFor` and `domainVerifyEmail` were written and had no callers,
-- and the only writer of `email_role` was the onboarding approval, which set it
-- with an empty token and an immediate `verified_at`. So an organisation whose
-- claimant is not the DNS administrator -- the ordinary case -- had no route to
-- a verified domain at all, and a verified domain is what gates auto-approval
-- on event claims.
--
-- A SEPARATE token from `organisation_domains.verification_token`, and that is
-- the point of this table. That column is the value published in the domain's
-- TXT record: public by design, and deliberately kept after verification so a
-- periodic re-check can confirm the record is still there. Reusing it for an
-- emailed link would let anybody who can read the DNS record verify the domain
-- without controlling any mailbox.
--
-- Hashed, single-use and expiring, mirroring `onboarding_email_tokens`.
CREATE TABLE IF NOT EXISTS "domain_email_tokens" (
  "token_hash" TEXT PRIMARY KEY,
  "domain_id"  UUID NOT NULL,
  "sent_to"    TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at"    TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "domain_email_tokens_domain_id_fkey" FOREIGN KEY ("domain_id")
    REFERENCES "organisation_domains"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- The cascade path, and "is there an open link for this domain".
CREATE INDEX IF NOT EXISTS "domain_email_tokens_domain_id_idx"
  ON "domain_email_tokens" ("domain_id");
