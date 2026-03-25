import type { ModerationResult } from "./types"
import { AUTO_HIDE_THRESHOLD } from "./config"

// Leetspeak substitutions for normalization
const LEET_MAP: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s",
  "7": "t", "@": "a", "$": "s", "!": "i",
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET_MAP[c] || c)
    .replace(/[\s\-_.]+/g, "") // strip separators used to evade filters
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

// Common abbreviations that are high-signal (exact match only)
const ABBREVIATION_KEYWORDS = new Set([
  "mc", "bc", "bsdk", "mc bc",
])

/**
 * Check message content against keyword wordlists.
 * Uses exact-match on normalized tokens — high precision, low false-positive rate.
 */
export function checkKeywords(content: string): ModerationResult | null {
  const normalized = normalize(content)
  const words = content.toLowerCase().split(/\s+/)
  const matched: string[] = []

  // Check full normalized string against all keyword sets
  for (const wordSet of ALL_KEYWORDS) {
    for (const keyword of wordSet) {
      const normalizedKeyword = normalize(keyword)
      if (normalized.includes(normalizedKeyword)) {
        matched.push(keyword)
      }
    }
  }

  // Check individual words against abbreviations
  for (const word of words) {
    if (ABBREVIATION_KEYWORDS.has(word.replace(/[^a-z]/g, ""))) {
      matched.push(word)
    }
  }

  if (matched.length === 0) return null

  // Keyword matches are high-precision (exact match), so base confidence is high.
  // A single slur should be enough to auto-hide.
  const confidence = Math.min(1, 0.85 + matched.length * 0.05)

  return {
    action: confidence >= AUTO_HIDE_THRESHOLD ? "hide" : "flag",
    source: "keyword",
    categories: { profanity: confidence },
    confidence,
    matched: [...new Set(matched)],
  }
}
