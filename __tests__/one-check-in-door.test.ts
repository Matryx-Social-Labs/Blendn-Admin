import { readFileSync } from "fs"
import { join } from "path"

/**
 * One door, two ways in (PL-G03, plan v2 step 4).
 *
 * `POST /events/:id/checkin` and `POST /venues/:id/live` both admit somebody
 * standing somewhere into a room. The rules about the person and the place —
 * the GPS accuracy ceiling, who may take part, the age gate, the fence and the
 * refusal it records — and everything a check-in writes live once, in
 * `lib/check-in-core.ts`. A second copy in either route is how the doors
 * drift: one learns a fix the other never hears of (the event door alone took
 * four geofence fixes in a year, each written down in its comments).
 *
 * Reads the source, so it is registered in negative-controls.json.
 */
const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const CORE = "lib/check-in-core.ts"
const DOORS = [
  "app/api/mobile/events/[eventId]/checkin/route.ts",
  "app/api/mobile/venues/[venueId]/live/route.ts",
]

/**
 * What only the core may do. Each is a rule a door could otherwise re-implement.
 * Names, not calls: a door that so much as imports one has started a copy.
 */
const CORE_ONLY: Array<[string, RegExp]> = [
  ["judge a position against a fence", /\b(?:evaluateCheckIn|distanceToGeofence|pointInFence)\b/],
  ["apply the accuracy ceiling", /\bMAX_GPS_ACCURACY_METERS\b/],
  ["apply the age gate", /\b(?:minAgeRefusal|mayParticipate)\b/],
  ["write a check-in", /event_check_ins\.(?:upsert|create|update)\(/],
  ["open a presence session", /\bopenSession\b/],
  ["put somebody in a room", /chat_group_members\.(?:create|upsert)\(|\bclaimAnonymousName\b/],
]

describe("both doors go through the one check-in core", () => {
  it.each(DOORS)("%s imports the core's gates and its seat", (door) => {
    const src = code(door)
    expect(src).toMatch(/from "@\/lib\/check-in-core"/)
    for (const fn of ["vagueFixRefusal(", "personAtTheDoor(", "fenceRefusal(", "seatAtTheDoor("]) {
      expect(src).toContain(fn)
    }
  })

  it.each(DOORS.flatMap((door) => CORE_ONLY.map(([what, re]) => [door, what, re] as const)))(
    "%s does not %s itself",
    (door, _what, re) => {
      expect(code(door)).not.toMatch(re)
    }
  )

  it("the core does each of them", () => {
    const src = code(CORE)
    for (const [, re] of CORE_ONLY) expect(src).toMatch(re)
  })
})
