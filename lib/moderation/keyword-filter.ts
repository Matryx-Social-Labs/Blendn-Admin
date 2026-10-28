import type { ModerationResult } from "./types"
import { AUTO_HIDE_THRESHOLD } from "./config"

// Leetspeak substitutions for normalization
const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "@": "a", "$": "s", "!": "i",
}

/**
 * Leetspeak folded, separators stripped. Catches `f-a-g` and `r3t4rd`.
 *
 * It also catches "the flag", and that is not a bug in this function -- it is
 * what stripping separators *means*. `checkKeywords` handles it by treating a
 * match found only here as a suspicion rather than a verdict.
 */
function normalizeAggressive(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET_MAP[c] || c)
    .replace(/[\s\-_.]+/g, "") // strip separators used to evade filters
}

/**
 * Leetspeak folded, words kept whole.
 *
 * A word is a run of letters, combining marks, numbers and the zero-width
 * joiners. The marks matter: in Devanagari, Tamil, Telugu and the rest a vowel
 * sign, a nasal mark, a nukta and a virama are `\p{M}`, not `\p{L}`, so a
 * split on "not a letter" tore every word apart at its vowels -- "लड़का" (boy)
 * became ["ल","ड","क"], the banned "लौड़ा" became ["ल","ड"], and the one matched
 * as a run inside the other (SCRUM-650). Zero-width characters are removed, so
 * a joiner inside a conjunct neither splits a word nor hides one.
 *
 * NFC first, so a nukta typed as one code point (U+095C) and as two
 * (U+0921 U+093C) are the same word -- Unicode keeps those two apart under NFC
 * because U+095C is a composition exclusion, hence NFC maps both to the pair.
 */
/** Zero-width characters: invisible, so a word with one inside is the same word (and inserting one is a classic way round a filter). */
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g
const NOT_IN_A_WORD = /[^\p{L}\p{M}\p{N}]+/u

function normalizeWords(text: string): string[] {
  return text
    .replace(ZERO_WIDTH, "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[013457]/g, (c) => LEET_MAP[c] || c)
    // `@ $ !` stand for a letter only when a letter follows ("f@g", "$hit"); a "!" after a word is punctuation.
    .replace(/[@$!](?=[\p{L}\p{N}])/gu, (c) => LEET_MAP[c] || c)
    .split(NOT_IN_A_WORD)
    .filter(Boolean)
}

// ── English slurs & profanity (high-precision exact match) ──
const ENGLISH_KEYWORDS = new Set([
  "nigger", "nigga", "faggot", "fag", "retard", "kike", "spic",
  "chink", "wetback", "tranny", "cunt",
])

// ── Hindi (Devanagari) ──
const HINDI_DEVANAGARI = new Set([
  "मादरचोद", "भोसडीके", "चूतिया", "गांड", "लौड़ा", "रंडी",
  "बहनचोद", "हरामी", "कुत्ते", "साले", "कमीने",
])

// ── Hindi (transliterated / Latin script) ──
const HINDI_TRANSLITERATED = new Set([
  "madarchod", "bhosadike", "bhosdi", "chutiya", "chutiye",
  "gaand", "lauda", "laude", "randi", "behenchod", "bsdk",
  "harami", "kamina", "kamine", "lodu",
])

// ── Tamil ──
const TAMIL_KEYWORDS = new Set([
  "ஒத்த", "தேவடியா", "பூல்", "கூதி", "சுன்னி",
  "thevadiya", "otha", "punda", "sunni", "koodi", "myiru",
])

// ── Telugu ──
const TELUGU_KEYWORDS = new Set([
  "లంజ", "దెంగు", "పూకు", "మొడ్డ", "లంజకొడుకు",
  "lanja", "dengu", "pooku", "modda", "lanjakoduku", "gudda",
])

// ── Kannada ──
const KANNADA_KEYWORDS = new Set([
  "ಸೂಳೆ", "ಮಗನೆ", "ಬೋಳಿ",
  "sule", "magane", "boli", "tunne",
])

// ── Malayalam ──
const MALAYALAM_KEYWORDS = new Set([
  "തായോളി", "കുണ്ണ", "പൂറ്",
  "thayoli", "kunna", "poori", "myre", "thendi",
])

// ── Bengali ──
const BENGALI_KEYWORDS = new Set([
  "চোদ", "মাগি", "খানকি", "শালা", "বাল",
  "chod", "magi", "khanki", "shala", "bal",
])

// ── Marathi ──
const MARATHI_KEYWORDS = new Set([
  "झवाड्या", "आईघाल",
  "zavadya", "aighala", "chinal", "bhikarchot",
])

// ── Gujarati ──
const GUJARATI_KEYWORDS = new Set([
  "ભોસડી", "ચૂતિયો",
  "ghando", "ghelchodo", "bhosadi", "chodyu",
])

// Merge all keyword sets
const ALL_KEYWORDS: Set<string>[] = [
  ENGLISH_KEYWORDS,
  HINDI_DEVANAGARI,
  HINDI_TRANSLITERATED,
  TAMIL_KEYWORDS,
  TELUGU_KEYWORDS,
  KANNADA_KEYWORDS,
  MALAYALAM_KEYWORDS,
  BENGALI_KEYWORDS,
  MARATHI_KEYWORDS,
  GUJARATI_KEYWORDS,
]

/** Is `needle` a contiguous run inside `haystack`? For multi-word keywords. */
function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { hit = false; break }
    }
    if (hit) return true
  }
  return false
}

// Common abbreviations that are high-signal (exact match only)
const ABBREVIATION_KEYWORDS = new Set([
  "mc", "bc", "bsdk", "mc bc",
])

/**
 * Check message content against the keyword wordlists.
 *
 * ## Two tiers, because the two questions are different
 *
 * The docstring here used to claim "exact-match on normalized tokens — high
 * precision, low false-positive rate". It was `String.includes` against a
 * string with every separator removed, so **"the flag" normalised to "theflag",
 * matched `fag`, and auto-hid at 0.85 confidence** — and each auto-hide counts
 * toward a three-strike auto-mute. Also "Scunthorpe", "assassin", "Bangkok".
 *
 * The tension is real and cannot be normalised away. Stripping separators is
 * what catches `f-a-g`, and it is the same operation that manufactures
 * `theflag`. So the two results stop sharing a verdict:
 *
 * | Tier | Match | Confidence | Action |
 * |---|---|---|---|
 * | 1 | a whole word is the keyword | 0.85+ | **hide** |
 * | 2 | only the separator-stripped string contains it | 0.5 | **flag** |
 *
 * Tier 2 still catches every evasion tier 1 misses — nothing stops being
 * detected. What changes is that a suspicion costs a human glance instead of an
 * automatic hide plus a third of a mute. Deliberate abuse dressed up as `f.a.g`
 * lands in the queue; somebody saying "the flag" does too, and a moderator
 * spends two seconds on it.
 *
 * §4d is explicit that the automatic bar stays high, and that precision has to
 * be fixed before the threshold is worth loosening. This is that fix.
 */
export function checkKeywords(content: string): ModerationResult | null {
  const aggressive = normalizeAggressive(content)
  const words = normalizeWords(content)
  const wordSet = new Set(words)

  const exact: string[] = []
  const evasive: string[] = []

  for (const keywords of ALL_KEYWORDS) {
    for (const keyword of keywords) {
      const asWords = normalizeWords(keyword)
      // A whole-word hit. Multi-word keywords match as a contiguous run.
      const isExact =
        asWords.length === 1
          ? wordSet.has(asWords[0])
          : containsRun(words, asWords)
      if (isExact) {
        exact.push(keyword)
      } else if (aggressive.includes(normalizeAggressive(keyword))) {
        evasive.push(keyword)
      }
    }
  }

  // Abbreviations are whole-word only and always have been; "mc bc" is a phrase.
  for (const abbreviation of ABBREVIATION_KEYWORDS) {
    const asWords = normalizeWords(abbreviation)
    const hit = asWords.length === 1 ? wordSet.has(asWords[0]) : containsRun(words, asWords)
    if (hit) exact.push(abbreviation)
  }

  if (exact.length === 0 && evasive.length === 0) return null

  /*
   * A whole-word slur is enough on its own to hide. A match that exists only
   * after the separators were removed is not, however many of them there are —
   * one sentence can manufacture several at once ("the flag" and "a s s" in the
   * same line), and stacking suspicion into certainty is how a filter starts
   * hiding ordinary English.
   */
  const confidence =
    exact.length > 0 ? Math.min(1, 0.85 + exact.length * 0.05) : 0.5

  const matched = exact.length > 0 ? exact : evasive

  return {
    action: confidence >= AUTO_HIDE_THRESHOLD ? "hide" : "flag",
    source: "keyword",
    categories: { profanity: confidence },
    confidence,
    matched: [...new Set(matched)],
  }
}

/**
 * The words a NAME, bio or card may be refused for: unambiguous slurs and
 * abuse only (PR #755 security review, H1).
 *
 * The lists above are for chat, where a whole-word hit hides one message. On
 * identity text the same hit refuses a sign-up or an onboarding step, and the
 * lists carry words that are also names, ordinary words, places and a faith:
 * "Magi", "Shala", "Bal" (Bal Krishna), "Boli" (a language), "Otha" (Tamil
 * for "one"), "Sunni", "Randi", "Laude", "Poori", "Gudda", "BC". Everything
 * not listed here is ALLOWED on identity text and flagged for a human
 * (`checkIdentityKeywords`).
 *
 * An explicit list rather than the chat list minus exceptions, on purpose: a
 * word added to the chat list later is flagged on a profile, never refused, so
 * nobody's name starts failing sign-up by surprise. Every entry must also be
 * in the chat list (`keyword-identity.test.ts`).
 */
export const IDENTITY_SLURS: ReadonlySet<string> = new Set([
  // English
  "nigger", "nigga", "faggot", "retard", "kike", "wetback", "tranny", "cunt",
  // Hindi
  "मादरचोद", "भोसडीके", "चूतिया", "बहनचोद", "लौड़ा",
  "madarchod", "bhosadike", "bhosdi", "chutiya", "chutiye", "behenchod", "bsdk",
  // Tamil
  "தேவடியா", "கூதி", "thevadiya", "myiru",
  // Telugu
  "లంజ", "దెంగు", "పూకు", "లంజకొడుకు", "lanja", "pooku", "lanjakoduku",
  // Kannada
  "ಸೂಳೆ",
  // Malayalam
  "തായോളി", "കുണ്ണ", "thayoli",
  // Bengali
  "খানকি", "khanki",
  // Marathi
  "झवाड्या", "आईघाल", "zavadya", "aighala", "bhikarchot",
  // Gujarati
  "ભોસડી", "ચૂતિયો", "ghelchodo", "bhosadi",
])

/** Every keyword the chat filter knows, for the subset test. */
export const CHAT_KEYWORDS: ReadonlySet<string> = new Set([...ALL_KEYWORDS.flatMap((s) => [...s]), ...ABBREVIATION_KEYWORDS])

/**
 * `checkKeywords` for identity text (a name, a bio, a crew card): `hide` only
 * for a whole-word hit on `IDENTITY_SLURS`; any other hit is a `flag`, which
 * the caller lets through and records for review.
 */
export function checkIdentityKeywords(content: string): ModerationResult | null {
  const result = checkKeywords(content)
  if (!result) return null
  const refused = result.action === "hide" ? (result.matched ?? []).filter((k) => IDENTITY_SLURS.has(k)) : []
  return refused.length > 0 ? { ...result, matched: refused } : { ...result, action: "flag" }
}
