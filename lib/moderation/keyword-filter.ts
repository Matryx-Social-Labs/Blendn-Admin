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
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET_MAP[c] || c)
    .replace(/[\s\-_.]+/g, "") // strip separators used to evade filters
}

/**
 * Leetspeak folded, words kept whole.
 *
 * Splits on anything that is not a letter or a number, so Devanagari, Tamil and
 * the rest survive -- `\s`-splitting would have been enough for English and
 * wrong for most of the wordlists this file carries.
 */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET_MAP[c] || c)
    .split(/[^\p{L}\p{N}]+/u)
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

  // Abbreviations are whole-word only and always have been.
  for (const word of words) {
    if (ABBREVIATION_KEYWORDS.has(word)) exact.push(word)
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
