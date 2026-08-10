-- An event can require a minimum age.
--
-- `profiles.age` has always accepted 13, and nothing anywhere connected that to
-- what an event actually is. A 16-year-old could check into a club night, and
-- the only thing standing between them and it was the door staff — who do not
-- see this system at all.
--
-- Nullable, and null for every existing row, because almost no event needs it:
-- a coffee meetup has no age policy and should not be made to declare one. The
-- organiser sets it when it matters, which is the only party who knows.
--
-- Enforced at check-in (`lib/age.ts`), and used to hide the event from anyone
-- whose stated age is below it. Not enforced on the listing when the age is
-- unknown: hiding every restricted event from every OAuth account — none of
-- which has an age yet — would empty their feed to punish a missing field. The
-- door is closed either way.

ALTER TABLE "events" ADD COLUMN "min_age" INTEGER;
