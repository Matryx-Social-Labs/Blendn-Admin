-- Password reset.
--
-- The approval email hands a host a generated password and tells them to change
-- it. Until now there was no reset flow at all, so anyone who lost that password
-- had exactly one route back: emailing support. This closes that.
--
-- Same shape as onboarding_email_tokens — hash only, single-use, expiring — with
-- a one-hour TTL rather than a day. This token changes a credential rather than
-- confirming an address, so a stale link in an inherited mailbox is worth far
-- more to whoever finds it.

CREATE TABLE "password_reset_tokens" (
    "token_hash" TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at"    TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("token_hash")
);

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexed because every reset revokes the user's other outstanding tokens, and
-- an unindexed FK is a seq scan on every User delete.
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");
