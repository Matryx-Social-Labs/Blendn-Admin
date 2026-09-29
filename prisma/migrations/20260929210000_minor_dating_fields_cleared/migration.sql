-- What a minor told us before the gates existed is cleared (SCRUM-477).
--
-- SCRUM-200 (#396) and SCRUM-294 (#409) refuse orientation, "interested in",
-- the consent to show them and the dating choice under 18, and strip them when
-- an age correction drops below 18. Both act on a write, so a row last written
-- before them kept the values. This applies the same clear, once, to every
-- profile whose age is known to be under 18.
--
-- Age is `ageFrom`'s rule (lib/age.ts): the birth date when it is not in the
-- future and gives 0-149 whole years on today's UTC date (as
-- `wholeYearsBetween` counts), else the stored `age`. The dates are compared as
-- plain timestamps so the session time zone cannot move a birthday. An unknown age is left alone: it is not
-- known to be a minor, and clearing every age-less adult's orientation would
-- destroy real data. The route still strips it on the next age write.
--
-- "Dating" in looking_for is free text; it goes as a lower-cased word with the
-- ASCII word boundaries of JS `\b`, the way `isAgeGated` matches it.
-- ponytail: no NFKD/accent folding here — pre-gate rows came from the app's
-- fixed choices; the route folds look-alikes on write.
WITH ages AS (
  SELECT
    id,
    COALESCE(
      CASE
        WHEN date_of_birth <= (now() AT TIME ZONE 'UTC')::date
          AND date_part('year', age((now() AT TIME ZONE 'UTC')::date::timestamp, date_of_birth::timestamp)) <= 149
          THEN date_part('year', age((now() AT TIME ZONE 'UTC')::date::timestamp, date_of_birth::timestamp))::int
      END,
      age
    ) AS years
  FROM profiles
)
UPDATE profiles AS p
SET
  orientations = '{}',
  interested_in = '{}',
  show_orientation = false,
  -- In the order they were chosen; a NULL list stays NULL.
  looking_for = CASE
    WHEN p.looking_for IS NULL THEN NULL
    ELSE ARRAY(
      SELECT v FROM unnest(p.looking_for) WITH ORDINALITY AS t (v, n)
      WHERE lower(v) !~ '(^|[^a-z0-9_])dating([^a-z0-9_]|$)'
      ORDER BY n
    )
  END,
  intent_default = array_remove(p.intent_default, 'dating'::connection_intent)
FROM ages
WHERE ages.id = p.id
  AND ages.years < 18
  -- Only rows with something to clear: every other row is left as it is.
  AND (
    cardinality(p.orientations) > 0
    OR cardinality(p.interested_in) > 0
    OR p.show_orientation
    OR 'dating'::connection_intent = ANY (p.intent_default)
    OR EXISTS (SELECT 1 FROM unnest(p.looking_for) AS v WHERE lower(v) ~ '(^|[^a-z0-9_])dating([^a-z0-9_]|$)')
  );
