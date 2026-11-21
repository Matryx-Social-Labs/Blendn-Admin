-- Crew waves (crews 5-A, S5; SCRUM-1094 part b). A crew wave is a crew like the receiving side is SHOWN:
-- the same row, the same uniques, the same Blend on a match, so a like from an installed build and a wave
-- from the other side still make one Mix. `is_wave` false is a like from before (secret until mutual).
-- Additive: NOT NULL with a constant default is metadata-only on PG 11+ (no rewrite).
--
-- crew_hides: "Block" on a crew (owner 2026-11-13) hides that crew from the person for good. Only the hider:
-- nothing is said to the crew, and nobody's account is blocked. Undone from Settings → Blocked.
-- Wrapped, because `migrate deploy` is not transactional.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "crew_likes" ADD COLUMN "is_wave" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "crew_hides" (
    "user_id" TEXT NOT NULL,
    "crew_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_hides_pkey" PRIMARY KEY ("user_id", "crew_id")
);

CREATE INDEX "crew_hides_crew_id_idx" ON "crew_hides"("crew_id");

ALTER TABLE "crew_hides" ADD CONSTRAINT "crew_hides_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crew_hides" ADD CONSTRAINT "crew_hides_crew_id_fkey" FOREIGN KEY ("crew_id") REFERENCES "crews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
