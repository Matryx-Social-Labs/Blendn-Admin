import { normaliseVenueName } from "@/lib/venue-name"

/**
 * The fallback grouping key, used only where an event has no `venue_id`.
 *
 * The venue-owner screen used to group on the raw string, so "The Loft" and
 * "the loft" were two venues and one owner's numbers were split between them.
 *
 * The risk runs the other way too, and it is worse: merging two genuinely
 * different rooms combines one owner's figures with another's. So this is
 * deliberately shallow.
 */
describe("normaliseVenueName", () => {
  it("collapses case and surrounding whitespace", () => {
    expect(normaliseVenueName("  The Loft ")).toBe(normaliseVenueName("the loft"))
  })

  it("collapses repeated inner spaces", () => {
    expect(normaliseVenueName("Toit  Brewpub")).toBe(normaliseVenueName("Toit Brewpub"))
  })

  it("ignores a trailing comma", () => {
    expect(normaliseVenueName("Koramangala Social,")).toBe(normaliseVenueName("Koramangala Social"))
  })

  it("keeps genuinely different rooms apart", () => {
    // Merging two real venues is worse than leaving two spellings apart, so no
    // article-stripping and no fuzzy matching.
    expect(normaliseVenueName("The Loft")).not.toBe(normaliseVenueName("Loft Bar"))
    expect(normaliseVenueName("Social")).not.toBe(normaliseVenueName("Koramangala Social"))
    expect(normaliseVenueName("Toit")).not.toBe(normaliseVenueName("Toit Brewpub"))
  })

  it("does not strip punctuation that distinguishes a name", () => {
    expect(normaliseVenueName("Ce La Vi")).not.toBe(normaliseVenueName("CeLaVi"))
  })

  it("handles an empty-ish name without throwing", () => {
    expect(normaliseVenueName("   ")).toBe("")
  })
})
