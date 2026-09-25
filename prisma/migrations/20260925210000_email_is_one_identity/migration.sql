-- SCRUM-328: an address is one account, whatever its case. From this deploy
-- signup, sign-in, the dashboard and Google/Apple lowercase what they are
-- given; this lowercases what is already stored, so their exact lookups find
-- it.
--
-- A row is left as it is when another row shares its lowercase form. Two
-- accounts for one inbox need a person to decide which survives, and
-- lowercasing either would break the unique constraint and fail the deploy.
UPDATE "User" u
SET "email" = lower(u."email")
WHERE u."email" <> lower(u."email")
  AND NOT EXISTS (
    SELECT 1 FROM "User" t
    WHERE lower(t."email") = lower(u."email")
      AND t."id" <> u."id"
  );
