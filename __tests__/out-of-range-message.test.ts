import { outOfRangeMessage, WALKABLE_SHORTFALL_METRES } from "@/lib/checkin-messages"

/**
 * The refused-check-in sentence, at both distances it is actually seen at.
 *
 * It was one template built for the near case. Driven from Saarbrücken against
 * a Bengaluru event on staging, it produced:
 *
 *     You're about 7514501m outside the check-in area. Move closer to the venue
 *     and try again.
 *
 * Seven digits of metres, and advice that cannot be taken. The far case is the
 * wrong city, a lost fix, or an event opened from home — most of the ways this
 * refusal is ever seen.
 *
 * The client renders this verbatim and deliberately, so these assertions are
 * against the string a person reads, not against an internal shape.
 */
describe("the out-of-range refusal", () => {
  it("keeps the near sentence exactly, because the client pins it", () => {
    /*
     * `ashgabat/__tests__/checkInRefusal.test.ts` asserts this to the
     * character. It exists because the client once built its own version of
     * this sentence from fields the server does not send, and said "0m away" to
     * somebody 45m out.
     */
    expect(outOfRangeMessage(45)).toBe(
      "You're about 45m outside the check-in area. Move closer to the venue and try again."
    )
  })

  it("rounds, because a GPS fix has no sub-metre truth in it", () => {
    expect(outOfRangeMessage(45.4)).toContain("45m")
    expect(outOfRangeMessage(45.6)).toContain("46m")
  })

  it("switches to kilometres once the distance is not walkable", () => {
    // The real staging figure.
    expect(outOfRangeMessage(7514501)).toBe(
      "You're about 7515km from the venue, so check-in isn't available yet. Check in once you're there."
    )
  })

  it("stops telling somebody to move closer when they cannot", () => {
    /*
     * The half that made the old sentence wrong rather than merely ugly.
     * "Try again" is an action that cannot succeed from 7,000km away, and
     * offering it is worse than saying nothing.
     */
    const far = outOfRangeMessage(50_000)
    expect(far).not.toContain("Move closer")
    expect(far).not.toContain("try again")
  })

  it("changes band exactly at the threshold, not around it", () => {
    // Boundaries asserted rather than assumed: an off-by-one here shows up as
    // "You're about 1000m outside" or "You're about 1km", both defensible, so
    // only a pinned edge says which one shipped.
    expect(outOfRangeMessage(WALKABLE_SHORTFALL_METRES - 1)).toContain("999m")
    expect(outOfRangeMessage(WALKABLE_SHORTFALL_METRES)).toContain("1km")
  })

  it("never renders a bare number of metres in the thousands", () => {
    /*
     * The shape of the original defect, asserted across the range rather than
     * at one point — a fix that only handled the 7,514km case would pass every
     * test above and still print "4200m outside" to somebody across town.
     */
    for (const m of [1000, 4200, 90_000, 1_000_000, 7_514_501]) {
      expect(outOfRangeMessage(m)).not.toMatch(/\d{4,}m/)
    }
  })
})
