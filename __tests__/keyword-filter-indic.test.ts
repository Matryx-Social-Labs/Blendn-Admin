import { checkKeywords } from "@/lib/moderation/keyword-filter"

/*
 * Indic words are not split at their vowel signs (SCRUM-650).
 *
 * `normalizeWords` split on anything outside `\p{L}`, and a Devanagari vowel
 * sign (matra), nasal mark, nukta or virama is `\p{M}`. A word fell apart at
 * every one: "लड़का" (boy) became ["ल","ड","क"], the banned "लौड़ा" became
 * ["ल","ड"], and the keyword matched as a run inside the sentence -- hidden at
 * 0.9 and one strike toward an auto-mute for saying "the boy came". The same
 * held for every Indic wordlist here (Tamil, Telugu, Kannada, Malayalam,
 * Bengali, Marathi, Gujarati), in both directions: harmless words that hid,
 * and real slurs that could not match as the words they are.
 */
const hidden = (text: string) => checkKeywords(text)?.action === "hide"

describe("Hindi words that merely share consonants with a banned one", () => {
  // Each shares its consonant skeleton with a keyword once the vowel signs are dropped.
  it.each([
    ["लड़का आया", "boy, vs लौड़ा"],
    ["गाड़ी कहाँ है", "car, vs गांड"],
    ["गड़बड़ मत करो", "mess, vs गांड"],
    ["गाड़ियाँ खड़ी हैं", "cars, vs गांड"],
    ["रंगीन कपड़े", "colourful clothes, vs रंडी"],
    ["हरी सब्ज़ी", "green vegetable, vs हरामी"],
    ["कमीज़ पहनो", "shirt, vs कमीने"],
    ["गांव जा रहा हूँ", "village, vs गांड"],
    ["साला", "a different word from साले"],
  ])("does not hide %p (%s)", (text) => {
    expect(hidden(text)).toBe(false)
    expect(checkKeywords(text)?.matched ?? []).toEqual([])
  })

  it("leaves the whole sentence alone, not just the one word", () => {
    expect(checkKeywords("मेरा लड़का गाड़ी में गाँव गया और गड़बड़ नहीं की")).toBeNull()
  })
})

describe("Hindi words that are the banned word", () => {
  it.each([
    ["तू एक चूतिया है", "चूतिया"],
    ["तुम हरामी हो", "हरामी"],
    ["ये लौड़ा क्या कर रहा है", "लौड़ा"],
    ["वो रंडी है", "रंडी"],
    ["अबे गांड मत दिखा", "गांड"],
  ])("hides %p", (text, keyword) => {
    const result = checkKeywords(text)
    expect(result?.action).toBe("hide")
    expect(result?.matched).toContain(keyword)
  })

  it("matches however the nukta is typed: precomposed ड़ (U+095C) or ड + ़", () => {
    const precomposed = "ये लौड़ा क्या है"
    const decomposed = "ये लौड़ा क्या है"
    expect(hidden(precomposed)).toBe(true)
    expect(hidden(decomposed)).toBe(true)
  })

  it("sees through zero-width joiners: one inside a banned word does not hide it, one inside a harmless word does not split it", () => {
    expect(hidden("तू चूति\u200dया है")).toBe(true)
    expect(hidden("हरा\u200cमी")).toBe(true)
    expect(hidden("मेरा लड़\u200cका आया")).toBe(false)
  })

  it("matches a banned word followed by punctuation or inside quotes", () => {
    expect(hidden("हरामी!")).toBe(true)
    expect(hidden("“हरामी”, बोला")).toBe(true)
  })
})

describe("the other Indic lists keep their words whole", () => {
  it("Telugu: a different word that begins like a keyword is not the keyword", () => {
    expect(hidden("లంజకొడుకు")).toBe(true) // itself a keyword
    expect(hidden("లంక వెళ్ళాను")).toBe(false) // Lanka (Sri Lanka) shares the first consonant of లంజ
  })

  it("Bengali: শালা is the keyword, শালিক (a bird) is not", () => {
    expect(hidden("তুই শালা")).toBe(true)
    expect(hidden("একটি শালিক পাখি")).toBe(false)
  })

  it("Tamil: the keyword matches as a word, not inside a longer unrelated one", () => {
    expect(hidden("பூல்")).toBe(true)
    expect(hidden("பூமி")).toBe(false) // earth
  })
})

describe("Hinglish (Latin script)", () => {
  it.each(["tu harami hai", "oye madarchod", "kya chutiya banda hai", "bsdk", "bhosdi wale"])("hides %p", (text) => {
    expect(hidden(text)).toBe(true)
  })

  it.each(["Gandhi ji ki gaadi aayi", "main kal market gaya tha", "Claude ne kaha ki chalo", "kaminey movie dekhi"])(
    "does not hide %p",
    (text) => {
      expect(hidden(text)).toBe(false)
    }
  )
})

describe("punctuation after a word is punctuation, not a letter", () => {
  it("hides a slur followed by an exclamation mark, in English and Hinglish as well as Hindi", () => {
    expect(hidden("you retard!")).toBe(true)
    expect(hidden("oye madarchod!!")).toBe(true)
  })

  it("still reads a symbol inside or at the front of a word as the letter it stands for", () => {
    expect(hidden("what a r3t4rd")).toBe(true)
    expect(hidden("you f@ggot")).toBe(true)
  })
})

describe("multi-word entries", () => {
  it("matches 'mc bc' as a phrase and as its words", () => {
    expect(checkKeywords("oye mc bc")?.matched).toContain("mc bc")
    expect(hidden("oye mc bc")).toBe(true)
    expect(hidden("mc")).toBe(true)
    expect(hidden("bc")).toBe(true)
  })

  it("does not match the words in the wrong order or apart, as a phrase", () => {
    // "bc" alone is itself an abbreviation keyword, so this stays a hit; the phrase must not add a second one.
    const result = checkKeywords("bc phir mc")
    expect(result?.matched).toEqual(expect.arrayContaining(["bc", "mc"]))
    expect(result?.matched).not.toContain("mc bc")
  })
})
