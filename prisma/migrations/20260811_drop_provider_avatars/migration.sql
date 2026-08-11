-- `User.image` becomes a mirror of the photo somebody chose, and nothing else.
--
-- It held two different things: a provider avatar taken from Google at signup,
-- and the primary profile photo written by `PUT /profiles`. The surfaces
-- disagreed about which counted -- match cards read `photos[0] ?? user.image`
-- while conversations read `user.image` alone -- so the same person had a face
-- in one place and not the other. The provider half had also never been
-- through moderation, unlike every other image in the product.
--
-- This nulls any image that is not the user's own current primary photo.
-- Google signups who never uploaded end up with no photo, which is the honest
-- state: they never chose one.

UPDATE "User" u
SET "image" = NULL
WHERE u."image" IS NOT NULL
  AND u."image" IS DISTINCT FROM (
    SELECT p."photos"[1] FROM "profiles" p WHERE p."id" = u."id"
  );
