-- Live-ops alerts that outlive the tab they were computed in.
--
-- `deriveAlerts` ran only in a browser `useMemo`, so an `over_capacity` breach
-- at 23:40 was gone at 23:45 unless somebody happened to be looking.

CREATE TABLE "event_issues" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"        UUID NOT NULL,
  "occurrence_id"   UUID,
  "kind"            TEXT NOT NULL,
  "severity"        TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "body"            TEXT NOT NULL,
  "opened_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "last_seen_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "resolved_at"     TIMESTAMPTZ(6),
  "acknowledged_at" TIMESTAMPTZ(6),
  "acknowledged_by" TEXT,
  CONSTRAINT "event_issues_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE
);

CREATE INDEX "event_issues_event_id_resolved_at_opened_at_idx"
  ON "event_issues"("event_id", "resolved_at", "opened_at");

-- The invariant `schema.prisma` cannot express, and the one that makes a sweep
-- on a timer safe: at most ONE OPEN issue per event, occurrence and kind.
--
-- Without it every pass inserts a row, and a queue lasting an hour becomes
-- sixty identical alerts — which is how an alert feed becomes something people
-- scroll past. `COALESCE` because `occurrence_id` is nullable and NULLs do not
-- compare equal, so two null-occurrence issues of the same kind would both be
-- allowed through a plain partial unique.
CREATE UNIQUE INDEX "event_issues_one_open_per_kind"
  ON "event_issues"("event_id", COALESCE("occurrence_id", '00000000-0000-0000-0000-000000000000'::uuid), "kind")
  WHERE "resolved_at" IS NULL;
