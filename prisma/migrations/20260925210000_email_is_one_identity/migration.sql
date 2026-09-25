-- SCRUM-328: an address is one account, whatever its case. From this deploy
-- signup, sign-in, the dashboard and Google/Apple trim and lowercase what they
-- are given; this does the same to what is already stored, so their exact
-- lookups find it.
--
-- It refuses to run while two accounts share an address once case and spaces
-- are ignored. Folding either would break the unique constraint, and leaving
-- them would make every lookup land on whichever row happened to be lowercase
-- already, which may be one somebody registered to squat the address. A
-- person has to decide which survives. The failed deploy leaves the previous
-- one serving; merge the pair, then
--   npx prisma migrate resolve --rolled-back 20260925210000_email_is_one_identity
-- and deploy again.
--
-- The lock: the old deployment keeps serving while this runs, and a signup it
-- committed mid-migration could otherwise create exactly such a pair. Writers
-- wait for the commit; reads carry on.
LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  shared integer;
BEGIN
  SELECT count(*) INTO shared FROM (
    SELECT 1 FROM "User" GROUP BY lower(btrim("email")) HAVING count(*) > 1
  ) AS pairs;
  IF shared > 0 THEN
    RAISE EXCEPTION 'SCRUM-328: % address(es) belong to more than one account once case is ignored. List them with: SELECT lower(btrim(email)), array_agg(id) FROM "User" GROUP BY 1 HAVING count(*) > 1', shared;
  END IF;
END $$;

UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));
