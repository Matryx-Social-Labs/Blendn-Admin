-- One key per inbox (SCRUM-1172): lower case and trimmed, without a +tag, and for Gmail without dots, googlemail.com
-- read as gmail.com. Sign-up answers "already registered" when any account holds the key; Google and Apple refuse a new
-- account when a suspended one does (lib/suspended-identity.ts). Defined here and nowhere else: the app compares
-- identity_email("email") = identity_email($1) and never normalises in code. NULL, no "@", or nothing left on
-- either side of it ("@gmail.com", "x@", "...@gmail.com") gives NULL, which equals nothing. Builtins only, every one
-- IMMUTABLE, so the index may use it.
--
-- Its index, "User_identity_email_idx", is the next migration: CONCURRENTLY must stand alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE FUNCTION identity_email(email TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN local = '' OR domain = '' THEN NULL ELSE local || '@' || domain END
    FROM (SELECT CASE WHEN gmail THEN replace(untagged, '.', '') ELSE untagged END AS local,
                 CASE WHEN gmail THEN 'gmail.com' ELSE domain END AS domain
            FROM (SELECT coalesce(nullif(split_part(local_part, '+', 1), ''), local_part) AS untagged, domain,
                         domain IN ('gmail.com', 'googlemail.com') AS gmail
                    FROM (SELECT regexp_replace(typed, '@[^@]*$', '') AS local_part,
                                 substring(typed FROM '@([^@]*)$') AS domain
                            FROM (SELECT lower(btrim(email)) AS typed) AS t) AS parts) AS untagged) AS folded
$$;
COMMIT;
