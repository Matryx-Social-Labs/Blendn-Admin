import { readFileSync } from "fs"
import { join } from "path"

/**
 * A wrong pin was invisible until somebody complained — and most people do not
 * complain, they leave.
 *
 * That is worst for curated events, where an admin placed the pin from a
 * listing page without standing there, but an organiser who drew their fence
 * around the wrong building is equally blind.
 */

const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const DOOR = "app/api/mobile/events/[eventId]/checkin/route.ts"

describe("every refusal at the door is recorded", () => {
  const src = code(DOOR)

  it("records all six ways to be turned away", () => {
    /*
     * A refusal that is not recorded is a person who tried and left, and the
     * organiser never learns they existed. Every `errorResponse` on this path
     * that means "no, you cannot come in" gets one.
     */
    for (const reason of [
      "under_age", "too_early", "day_cancelled", "too_late", "no_geofence", "out_of_range",
    ]) {
      expect(src).toContain(`reason: "${reason}"`)
    }
  })

  it("records the shortfall on the one that means the pin might be wrong", () => {
    /*
     * Everybody twenty metres out is a pin on the wrong side of the street; a
     * wide spread is a fence too tight for the venue. Neither is visible
     * without the number.
     */
    expect(src).toMatch(/shortfallMetres: verdict\.shortfall/)
    expect(src).toMatch(/accuracyMetres: gpsAccuracy/)
  })

  it("never records coordinates", () => {
    /*
     * The shortfall is everything the diagnosis needs and cannot locate
     * anybody. G11 found GPS surviving account deletion on `event_check_ins`;
     * adding a second table with the same problem in order to fix the first
     * would be absurd.
     */
    const calls = [...src.matchAll(/recordRefusal\(\{[\s\S]*?\}\)/g)].map((m) => m[0])
    expect(calls.length).toBe(6)
    for (const call of calls) {
      /*
       * Word-bounded. The first draft used `/lat|lng|.../` and failed on
       * `reason: "too_late"` — a substring match inside a word, which is the
       * same trap the keyword filter auto-hid "the flag" with.
       */
      expect(call).not.toMatch(/\b(lat|lng|latitude|longitude)\b/)
    }
  })
})

describe("recording never breaks the refusal", () => {
  const src = code("lib/check-in-refusals.ts")

  it("is fire-and-forget with a catch", () => {
    /*
     * The caller is already returning a 400. Turning that into a 500 because a
     * diagnostic write failed would replace a useful refusal with a useless one.
     */
    expect(src).toMatch(/export function recordRefusal/)
    expect(src).toMatch(/\.catch\(\(error: unknown\) =>/)
    expect(src).not.toMatch(/export async function recordRefusal/)
  })

  it("stores no coordinate columns at all", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
    const model = /model check_in_refusals \{[\s\S]*?\n\}/.exec(schema)
    expect(model).not.toBeNull()
    expect(model![0]).not.toMatch(/latitude|longitude/)
    expect(model![0]).toMatch(/shortfall_metres/)
  })

  it("deletes with the user", () => {
    /*
     * ER13: every new model declares delete / anonymise / retain-aggregate
     * before it ships. These rows are diagnostic, not evidence, and the
     * aggregate a reviewer reads survives the individual rows going.
     */
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
    const model = /model check_in_refusals \{[\s\S]*?\n\}/.exec(schema)!
    expect(model[0]).toMatch(/user\s+User\s+@relation\([^)]*onDelete: Cascade/)
  })
})

describe("the summary a curation reviewer reads", () => {
  const src = code("lib/check-in-refusals.ts")

  it("counts people, not attempts", () => {
    /*
     * One person trying four times from the pavement is one person with a
     * problem. Counting attempts would make them look like a crowd — the same
     * mistake `lib/counting.ts` documents across nine other call sites.
     */
    expect(src).toMatch(/new Set\(rows\.map\(\(r\) => r\.user_id\)\)\.size/)
    // And keeps the attempt count separately, because the ratio is informative.
    expect(src).toMatch(/attempts: rows\.length/)
  })

  it("is bounded", () => {
    // A pathological event does not get to pull its whole history into a
    // dashboard render, and a thousand refusals says the same as ten thousand.
    expect(src).toMatch(/take: 1_000/)
  })

  it("says which reason dominates", () => {
    // A wrong pin and a wrong time produce identical silence and are
    // distinguishable only by this.
    expect(src).toMatch(/topReason/)
  })
})
