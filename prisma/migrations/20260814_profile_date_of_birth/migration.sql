-- The fact behind the number.
--
-- `profiles.age` is an integer captured at signup, so it is wrong the day
-- after and gets wronger. With an 18+ gate that decay is silent and lands on
-- exactly the people the gate exists for: someone who signs up at 17 stays 17
-- forever and keeps being refused a year later, and someone who typed 18 at 17
-- stays 18 with nothing to re-derive from.
--
-- `age` is NOT dropped. Every existing row has a number and no date, and a
-- number cannot be turned back into a date — those rows keep it as the fallback
-- until the person re-enters their birthday. See `ageFrom` in lib/age.ts, which
-- is the only thing that should read either column.
--
-- DATE, not TIMESTAMP: there is no meaningful time of day, and storing one
-- invites a timezone shift across a birthday — the precise boundary the gate
-- turns on.

ALTER TABLE "profiles" ADD COLUMN "date_of_birth" DATE;
