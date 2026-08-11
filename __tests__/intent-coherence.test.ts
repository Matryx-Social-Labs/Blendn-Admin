import { intentsAreCoherent } from "@/lib/validations/profile"

/*
 * "Just here for the event" means "I am not looking to connect".
 *
 * Pairing it with `dating` or `networking` is not a preference, it is a
 * contradiction — and a real account reached staging holding all four at once,
 * because the per-event screen enforced exclusivity and `about-you` did not.
 * Two clients agreeing is not a rule; it is two clients that happen to agree
 * until somebody writes a third or calls the API directly.
 *
 * `effectiveIntents` and the damping in `lib/matching.ts` both read this set as
 * a signal about what somebody wants. An incoherent set makes that reading
 * meaningless, and nothing throws.
 */

describe("intentsAreCoherent", () => {
  it("accepts just_here on its own", () => {
    expect(intentsAreCoherent(["just_here"])).toBe(true)
  })

  it("rejects just_here combined with anything", () => {
    expect(intentsAreCoherent(["just_here", "dating"])).toBe(false)
    expect(intentsAreCoherent(["dating", "just_here"])).toBe(false)
    // The state a real account actually reached.
    expect(intentsAreCoherent(["dating", "networking", "friendship", "just_here"])).toBe(false)
  })

  it("accepts any combination that does not include just_here", () => {
    expect(intentsAreCoherent(["dating", "networking", "friendship"])).toBe(true)
    expect(intentsAreCoherent(["networking"])).toBe(true)
  })

  it("accepts the empty set", () => {
    // "I have not said" is different from "I said nothing applies", and only
    // the second one is `just_here`. An empty array must stay writable.
    expect(intentsAreCoherent([])).toBe(true)
  })
})
