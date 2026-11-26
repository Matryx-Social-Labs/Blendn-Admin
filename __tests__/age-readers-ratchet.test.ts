import { execFileSync } from "child_process"

/**
 * Who reads a person's age (D-030, SCRUM-1384). Before a reveal a room row sends `ageBand` from `roomPersonFacts`
 * (lib/public-profile.ts), never the age: a new reader is either a gate on the caller's own age, or a surface that
 * must go through that helper. This list makes the choice deliberate.
 */
const KNOWN = [
  "app/api/mobile/events/[eventId]/checkins/route.ts",
  "app/api/mobile/events/[eventId]/matches/preferences/route.ts",
  "app/api/mobile/events/cities/route.ts",
  "app/api/mobile/events/route.ts",
  "app/api/mobile/events/search/route.ts",
  "app/api/mobile/friends/[userId]/route.ts",
  "app/api/mobile/profiles/[userId]/route.ts",
  "app/api/mobile/venues/[venueId]/live/route.ts",
  "app/api/mobile/venues/[venueId]/route.ts",
  "app/api/mobile/venues/[venueId]/upcoming/route.ts",
  "app/api/mobile/venues/route.ts",
  "app/api/mobile/venues/summary/route.ts",
  "app/dashboard/users/actions.ts",
  "lib/age.ts",
  "lib/board-access.ts",
  "lib/check-in-core.ts",
  "lib/crews/crews.ts",
  "lib/event-door.ts",
  "lib/matches.ts",
  "lib/night-people.ts",
  "lib/offers/person.ts",
  "lib/places-inside.ts",
  "lib/presence-sweeper.ts",
  "lib/public-profile.ts",
  "lib/self-profile.ts",
  "lib/ticket-holds.ts",
]

it("no new file reads an age without deciding whether it is a gate or goes through roomPersonFacts", () => {
  const found = execFileSync("git", ["grep", "-l", "ageFrom(", "--", "app", "lib"], { encoding: "utf8" }).trim().split("\n").sort()
  expect(found).toEqual([...KNOWN].sort())
})
