import { MAX_INTERESTS } from "@/lib/constants"

/**
 * The cap on structured interests, and why it is not a UI preference.
 *
 * `components/InterestPicker.tsx` claimed for months that "the server rejects
 * more than this per call". It did not — there was no cap in the route, and the
 * only thing holding the line was a client constant anyone could edit out.
 *
 * Ranking sums IDF weights over shared interests. IDF damps *a category many
 * people hold*; it does nothing about *one person holding many categories*. So
 * ticking all 67 leaves barely moves any holder count, shares an interest with
 * everybody at full rarity weight, and puts you top of every list in the room.
 * The damping only arrives once enough people copy you — meaning the first
 * person to try it is rewarded, which is the wrong direction for an incentive.
 *
 * These pin the arithmetic the route performs. The route itself is covered by
 * the integration suite; this is the part that has to stay true regardless of
 * how the query is written.
 */
describe("the interest cap", () => {
  /** What the route computes: held ∪ new, counted on the ids that are actually new. */
  const wouldHoldAfter = (held: string[], sent: string[]) => {
    const heldIds = new Set(held)
    const adding = [...new Set(sent)].filter((id) => !heldIds.has(id))
    return heldIds.size + adding.length
  }

  it("is ten", () => {
    expect(MAX_INTERESTS).toBe(10)
  })

  it("counts what you will hold afterwards, not what one call sends", () => {
    // The hole a per-call limit leaves: ten calls of one walk straight past it.
    const held = Array.from({ length: 10 }, (_, i) => `c${i}`)
    expect(wouldHoldAfter(held, ["new"])).toBe(11)
    expect(wouldHoldAfter(held, ["new"])).toBeGreaterThan(MAX_INTERESTS)
  })

  it("accepts exactly the cap — a limit that refuses everything is not a limit", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `c${i}`)
    expect(wouldHoldAfter([], ten)).toBe(MAX_INTERESTS)
    expect(wouldHoldAfter([], ten)).not.toBeGreaterThan(MAX_INTERESTS)
  })

  it("does not refuse a save that changes nothing", () => {
    /*
     * The write is `skipDuplicates`, so re-sending something already held is a
     * no-op. A naive `held.length + sent.length` would reject a client
     * re-submitting an unchanged form at the cap — a save that adds nothing.
     */
    const held = Array.from({ length: 10 }, (_, i) => `c${i}`)
    expect(wouldHoldAfter(held, ["c3", "c7"])).toBe(10)
    expect(wouldHoldAfter(held, ["c3", "c7"])).not.toBeGreaterThan(MAX_INTERESTS)
  })

  it("ignores duplicates within one request", () => {
    expect(wouldHoldAfter([], ["a", "a", "a"])).toBe(1)
  })
})
