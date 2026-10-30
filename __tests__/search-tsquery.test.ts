import { tsQueryFrom } from "@/lib/search-tsquery"

/*
 * SCRUM-946. `events/search?q=<` answered 500: the old sanitiser removed a
 * hand-picked set of tsquery operators and `<` (the phrase operator, `<->`) was
 * not on it. Only letters and digits reach to_tsquery now.
 */
describe("tsQueryFrom", () => {
  it.each(["<", "<->", "a<b", "@@", "!", "(", "a & | b", "\\", "'", "\"", ":*", "foo:bar", "a\u0000b"])(
    "leaves no operator in %j",
    (q) => {
      const out = tsQueryFrom(q)
      expect(out === null || /^[\p{L}\p{M}\p{N}]+:\*( & [\p{L}\p{M}\p{N}]+:\*)*$/u.test(out)).toBe(true)
    }
  )

  it("is null when nothing searchable is left", () => {
    expect(tsQueryFrom("<")).toBeNull()
    expect(tsQueryFrom("  ")).toBeNull()
  })

  it("prefix-matches every word and keeps non-Latin letters", () => {
    expect(tsQueryFrom("live jazz")).toBe("live:* & jazz:*")
    expect(tsQueryFrom("ಬೆಂಗಳೂರು")).toBe("ಬೆಂಗಳೂರು:*")
  })
})
