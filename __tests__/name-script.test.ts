import { hasMixedScripts, refuseMixedScript } from "@/lib/name-script"

/*
 * SCRUM-959: a Cyrillic "і" inside "Third Wave" looks identical and gets a
 * different name key, so the uniqueness check cannot see it. Refuse the
 * mixture at the writer instead of keeping a confusables table.
 */
describe("hasMixedScripts", () => {
  it.each([
    ["Thіrd Wave", "Cyrillic і in a Latin word"],
    ["Third Wаve", "Cyrillic а"],
    ["Aрple", "Cyrillic р"],
    ["Αpple", "Greek Α"],
    ["Third Wave Ѕtore", "Cyrillic in the last word"],
    ["Աpple", "Armenian Ա"],
    ["ᎪBC Coffee", "Cherokee Ꭺ"],
    ["ᑕafe Noir", "Canadian syllabics ᑕ"],
    ["ꓚafe Noir", "Lisu ꓚ"],
    ["𝐓𝐡і𝐫𝐝 𝐖𝐚𝐯𝐞", "bold-math letters (Common) plus one Cyrillic і: the key folds them to Latin"],
    ["Ｔｈіrd Ｗave", "full-width Latin plus Cyrillic і"],
  ])("flags %s (%s)", (name) => {
    expect(hasMixedScripts(name)).toBe(true)
  })

  it.each([
    "Third Wave",
    "Nightshift Collective",
    "Café Noir & Co.",
    "Ñandú 24/7",
    "Блог",
    "Ελληνικά",
    "東京 Cafe",
    "カフェ Third Wave",
    "Chai 2.0 – العربية",
    "Ｔｈｉｒｄ Ｗａｖｅ",
    "",
  ])("lets %s through", (name) => {
    expect(hasMixedScripts(name)).toBe(false)
  })
})

describe("refuseMixedScript", () => {
  it("throws a Refusal naming the problem for a mixed name", () => {
    expect(() => refuseMixedScript("Thіrd Wave")).toThrow(/one alphabet/i)
  })
  it("returns for a single-script name", () => {
    expect(() => refuseMixedScript("Third Wave")).not.toThrow()
  })
})
