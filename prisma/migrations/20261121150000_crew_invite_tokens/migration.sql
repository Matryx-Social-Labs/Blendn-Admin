-- Crew invite links (crews 3-B, S7; SCRUM-1094 part b2): `https://www.blendn.app/c/<token>` brings in somebody
-- who is not the sharer's Blend'n friend yet. Single use, 7 days, good only while the sharer is in the crew;
-- joining by it also makes the two friends (lib/crews/links.ts). An open link holds no seat.
-- Additive: a new table. Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE "crew_invite_tokens" (
    "id" UUID NOT NULL,
    "crew_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(6),
    "used_by" TEXT,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "crew_invite_tokens_pkey" PRIMARY KEY ("id"),
    -- A link is spent one way: used or revoked, never both. (`used_by` may go NULL: the joiner deleted their account.)
    CONSTRAINT "crew_invite_tokens_used_shape" CHECK ("used_at" IS NULL OR "revoked_at" IS NULL),
    CONSTRAINT "crew_invite_tokens_token_shape" CHECK ("token" ~ '^[A-Za-z0-9_-]{22}$')
);

CREATE UNIQUE INDEX "crew_invite_tokens_token_key" ON "crew_invite_tokens"("token");
CREATE INDEX "crew_invite_tokens_created_by_created_at_idx" ON "crew_invite_tokens"("created_by", "created_at");
CREATE INDEX "crew_invite_tokens_crew_id_idx" ON "crew_invite_tokens"("crew_id");
CREATE INDEX "crew_invite_tokens_used_by_idx" ON "crew_invite_tokens"("used_by");

ALTER TABLE "crew_invite_tokens" ADD CONSTRAINT "crew_invite_tokens_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crew_invite_tokens" ADD CONSTRAINT "crew_invite_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crew_invite_tokens" ADD CONSTRAINT "crew_invite_tokens_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
