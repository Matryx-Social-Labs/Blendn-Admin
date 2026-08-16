import { readFileSync } from "fs"
import { join } from "path"

/**
 * `age` on the roster.
 *
 * The Grid's cards were reduced to a name and a field of work, because
 * `sharedInterests` is usually empty and `workField` is null in any room under
 * eight. Age was the one further fact already public elsewhere.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")

describe("age is derived, and the birth date never leaves", () => {
  it("sends whole years, computed by ageFrom", () => {
    /*
     * `ageFrom` prefers `date_of_birth` and falls back to the stored number,
     * because "one day either side of a birthday is the difference between 17
     * and 18". Both columns are selected; neither is returned.
     */
    const src = read("lib", "matches.ts")
    expect(src).toContain("age: ageFrom(c.user.profile)")
    const card = src.slice(src.indexOf("export interface MatchCard"))
    expect(card.slice(0, card.indexOf("}"))).not.toContain("date_of_birth")
  })

  it("exposes nothing new", () => {
    /*
     * `publicProfileFields` already returns `age` to any authenticated caller,
     * outside the identity gate. Withholding it on the roster only made the
     * card disagree with the profile one tap away.
     */
    expect(read("app", "api", "mobile", "profiles", "[userId]", "route.ts")).toContain(
      "age: profileAge"
    )
  })

  it("is NOT suppressed in a small room, unlike work field", () => {
    /*
     * `workField` is nulled below `MIN_ROOM_FOR_WORK_FIELD` because four
     * attributes name one person. Age is already public, so suppressing it here
     * would withhold nothing while making two endpoints disagree.
     */
    const src = read("lib", "matching.ts")
    expect(src).toContain("workField: roomIsBigEnough ? candidate.workField : null")
    expect(src).toContain("age: candidate.age ?? null")
  })

  it("is optional going in and explicit coming out", () => {
    // A profile may carry neither a birth date nor a stored age. Required on
    // the way out so every caller handles "not known" rather than forgetting it.
    const src = read("lib", "matching.ts")
    const cand = src.slice(src.indexOf("export interface MatchCandidate"))
    expect(cand.slice(0, cand.indexOf("\n}"))).toContain("age?: number | null")
  })
})
