-- One ask per post, ever; and the asker's own half of a withdrawn decline.
--
-- 1. One ask per post, ever (step 6b, decision D-a).
--
-- Refusing a re-ask only after a decline told the asker they had been
-- declined, so every re-ask is refused. The route already refuses it with a
-- read; this makes the database hold it, replacing the partial unique that
-- only stopped two PENDING asks.
--
-- Duplicates first, because a unique index cannot be built over them and a
-- failed migration kills the deploy. Checked read-only on 2026-10-01: staging
-- had 0 duplicate (post_id, from_user_id) pairs among 2 rows; production has
-- no board tables yet. Kept anyway for any database that has them: the most
-- decisive row survives (accepted > pending > declined > withdrawn, then the
-- newest), because an accepted ask has a conversation behind it and a pending
-- one is somebody still waiting.
DELETE FROM "board_requests" br
USING (
  SELECT "id",
         row_number() OVER (
           PARTITION BY "post_id", "from_user_id"
           ORDER BY CASE "status"
                      WHEN 'accepted' THEN 0
                      WHEN 'pending' THEN 1
                      WHEN 'declined' THEN 2
                      ELSE 3
                    END,
                    "created_at" DESC
         ) AS rn
  FROM "board_requests"
) ranked
WHERE br."id" = ranked."id" AND ranked.rn > 1;

DROP INDEX IF EXISTS "board_requests_one_pending_per_post";
CREATE UNIQUE INDEX "board_requests_post_id_from_user_id_key"
  ON "board_requests"("post_id", "from_user_id");

-- 2. The asker withdrew an ask that had been declined (decision D-b).
--
-- A decline is never delivered, so to the asker it is still waiting and they
-- may withdraw it. The author keeps `declined` and `decided_at`; this column is
-- the asker's half. It only means anything on a declined row.
ALTER TABLE "board_requests" ADD COLUMN "asker_withdrawn_at" TIMESTAMPTZ(6);
ALTER TABLE "board_requests" ADD CONSTRAINT "board_requests_asker_withdrawn_only_declined"
  CHECK ("asker_withdrawn_at" IS NULL OR "status" = 'declined');
