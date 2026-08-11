-- What we have looked at, and what we concluded.
--
-- Moderation degrades open: a vendor outage must not stop somebody having a
-- profile photo. That makes "every URL in profiles.photos has been checked" a
-- claim rather than a fact, unless the outcome is recorded. `checked = false`
-- marks the rows a sweeper should revisit.
--
-- Keyed on the URL, not the user: the same object survives being removed from a
-- profile and added back, and re-checking it would repeat work already done.

CREATE TABLE IF NOT EXISTS "photo_checks" (
  "url"        TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL,
  "checked"    BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "photo_checks_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "photo_checks_user_id_idx" ON "photo_checks" ("user_id");
-- The sweeper's query: "what still needs looking at".
CREATE INDEX IF NOT EXISTS "photo_checks_checked_created_at_idx" ON "photo_checks" ("checked", "created_at");
