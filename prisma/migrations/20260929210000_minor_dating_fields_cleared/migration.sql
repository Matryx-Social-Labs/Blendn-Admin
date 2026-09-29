-- What a minor told us before the gates existed is cleared (SCRUM-477).
--
-- SCRUM-200 (#396) and SCRUM-294 (#409) refuse orientation, "interested in",
-- the consent to show them and the dating choice under 18, and strip them when
-- an age correction drops below 18. Both act on a write, so a row last written
-- before them kept the values. This applies the same clear, once, to every
-- profile whose age is known to be under 18.
--
-- Age is `ageFrom`'s rule (lib/age.ts): the birth date when it gives 0-149
-- whole years, else the stored `age`. An unknown age is left alone: it is not
-- known to be a minor, and clearing every age-less adult's orientation would
-- destroy real data. The route still strips it on the next age write.
--
-- "Dating" in looking_for is free text; it goes as a lower-cased word, the way
-- `isAgeGated` matches it. ponytail: no NFKD/accent folding here — pre-gate
-- rows came from the app's fixed choices; the route folds look-alikes on write.
WITH ages AS (
  SELECT
    id,
    COALESCE(
      CASE
        WHEN date_part('year', age(CURRENT_DATE, date_of_birth)) BETWEEN 0 AND 149
          THEN date_part('year', age(CURRENT_DATE, date_of_birth))::int
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
  looking_for = ARRAY(SELECT v FROM unnest(p.looking_for) AS v WHERE lower(v) !~ '\mdating\M'),
  intent_default = array_remove(p.intent_default, 'dating'::connection_intent)
FROM ages
WHERE ages.id = p.id
  AND ages.years < 18
  AND (
    cardinality(p.orientations) > 0
    OR cardinality(p.interested_in) > 0
    OR p.show_orientation
    OR 'dating'::connection_intent = ANY (p.intent_default)
    OR EXISTS (SELECT 1 FROM unnest(p.looking_for) AS v WHERE lower(v) ~ '\mdating\M')
  );
