-- SCRUM-956: a brand name and an organisation name are unique across
-- organisations (owner ruling 2026-10-30), held by the database so two requests
-- at once cannot both get through a check-then-write.
--
--   sponsors      one active brand per name_key (the existing normalised key:
--                 NFKD, marks, case, punctuation and zero-width characters out),
--                 whoever owns it or nobody. The per-organisation index stays.
--   organisations the name as one person reads it (NFKC, zero-width characters
--                 out, whitespace collapsed, lower-cased): lib/org-name-key.ts
--                 holds the same expression.
--
-- Each index is created only if the data already agrees: a duplicate that
-- predates it would fail the whole deploy, and `migrate deploy` is not
-- transactional across a failed file's earlier statements. When a duplicate
-- exists the migration warns with the keys and leaves the application check as
-- the only guard until the duplicates are merged and the index is created.
-- Staging had none on 2026-10-31.
BEGIN;

DO $$
DECLARE
  dup_brands text;
  dup_orgs text;
BEGIN
  SELECT string_agg(name_key, ', ') INTO dup_brands FROM (
    SELECT name_key FROM sponsors
     WHERE deleted_at IS NULL AND merged_into IS NULL
     GROUP BY name_key HAVING count(*) > 1) d;
  IF dup_brands IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "sponsors_name_key_active_uniq"
      ON "sponsors" ("name_key")
      WHERE "deleted_at" IS NULL AND "merged_into" IS NULL;
  ELSE
    RAISE WARNING 'sponsors_name_key_active_uniq NOT created: duplicate active brand keys: %', dup_brands;
  END IF;

  SELECT string_agg(k, ', ') INTO dup_orgs FROM (
    SELECT lower(btrim(regexp_replace(regexp_replace(normalize(display_name, NFKC), '[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', '', 'g'), '\s+', ' ', 'g'))) AS k
      FROM organisations
     GROUP BY 1 HAVING count(*) > 1) d;
  IF dup_orgs IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "organisations_name_key_uniq"
      ON "organisations" ((lower(btrim(regexp_replace(regexp_replace(normalize(display_name, NFKC), '[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', '', 'g'), '\s+', ' ', 'g')))));
  ELSE
    RAISE WARNING 'organisations_name_key_uniq NOT created: duplicate organisation names: %', dup_orgs;
  END IF;
END $$;

COMMIT;
