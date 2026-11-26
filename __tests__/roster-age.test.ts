import { readFileSync } from "fs"
import { join } from "path"

/**
 * `age` on the roster: derived, and never the birth date. Since D-030 (SCRUM-1384) a card sends it only for somebody
 * the room names to you; before a reveal it sends `ageBand` (`roomPersonFacts`, room-person-facts.itest.ts).
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

  it("is optional going in and explicit coming out", () => {
    // A profile may carry neither a birth date nor a stored age. Required on
    // the way out so every caller handles "not known" rather than forgetting it.
    const src = read("lib", "matching.ts")
    const cand = src.slice(src.indexOf("export interface MatchCandidate"))
    expect(cand.slice(0, cand.indexOf("\n}"))).toContain("age?: number | null")
  })
})
