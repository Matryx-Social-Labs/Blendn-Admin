jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))
import { crewInBody } from "@/lib/crews/presence"

/** The crew push's words (crews NOTES S3, owner 1a): who is in, never who is not, never where. */
describe("crewInBody", () => {
  const HOLD = " Hold to Blend’n when you get there."

  it.each([
    [["Priya"], "Priya is in."],
    [["Priya", "Arjun"], "Priya and Arjun are in."],
    [["Priya", "Arjun", "Meera"], "Priya, Arjun and Meera are in."],
    [["Priya", "Arjun", "Meera", "Dev"], "Priya, Arjun and 2 others are in."],
    [Array.from({ length: 11 }, (_, i) => `M${i}`), "M0, M1 and 9 others are in."],
  ])("%j → %s, plus the hold line for a crewmate not in yet", (names, said) => {
    expect(crewInBody(names, true)).toBe(said)
    expect(crewInBody(names, false)).toBe(said + HOLD)
  })

  it("never glues a suffix to a 32-character name", () => {
    const long = "Indiranagar Sunrise Run Club Cre"
    expect(crewInBody([long], false)).toBe(`${long} is in.${HOLD}`)
  })
})
