import {
  type Classification,
  type IssueCategory,
  type Sentiment,
} from "./taxonomy"

/**
 * Tier 2: a cheap first pass whose only job is to be *sure* or to say it is
 * not.
 *
 * This is deliberately not a general-purpose sentiment analyser. Lexicon
 * scoring is meaningfully worse than a transformer on social text — published
 * comparisons put VADER around 50% against ~80% for a tuned model — so using
 * it to label everything would ship wrong labels cheaply.
 *
 * What it is good enough for is discarding the obvious. Most event chat is
 * neutral logistics ("anyone getting there early?"), and paying an LLM to read
 * those is the waste worth removing. So: return a confident label only when the
 * signal is unambiguous, and return null otherwise so tier 3 gets it.
 *
 * Every message it declines to label costs an LLM call. Every message it labels
 * wrongly is a lie in the digest. Bias toward declining.
 */

/** Category cues. Order matters only in that safety is checked first. */
const CATEGORY_CUES: Array<{ category: IssueCategory; patterns: RegExp[] }> = [
  {
    category: "safety_conduct",
    patterns: [
      /\b(harass(ed|ing|ment)?|groped?|grabbing|assault|threat(en|ened)?|creep(y|ing)?|unsafe|fight|punch|stalk(ing|ed)?)\b/i,
      // Following is the pattern most often reported calmly and in the third
      // person — "a man has been following us" read as neutral chatter in an
      // earlier version of this list, which is the false negative this whole
      // category exists to prevent. Match the verb plus any object pronoun
      // rather than one fixed phrase.
      /\bfollow(ing|ed)\b[^.!?]{0,20}\b(me|us|her|him|them|my friend)\b/i,
      /\b(passed out|fainted|collaps(ed|ing)|ambulance|overdose|seizure|needs help|not ok(ay)?)\b/i,
    ],
  },
  {
    category: "entry_queue",
    patterns: [
      /\b(queue|queuing|queueing|line|lineup|door(s)?|entry|entrance|getting in|let in|id check|wristband|scan(ning)?)\b/i,
    ],
  },
  {
    category: "crowding",
    patterns: [/\b(packed|crowded|crush|can'?t move|too many people|rammed|sardines|squeeze|bottleneck)\b/i],
  },
  {
    category: "facilities",
    patterns: [/\b(toilet|loo|bathroom|restroom|washroom|freezing|boiling|aircon|air con|filthy|dirty|smell(s|y)?|seating|no seats|wheelchair|step free)\b/i],
  },
  {
    category: "sound_av",
    patterns: [/\b(sound|audio|volume|too loud|too quiet|mix|acoustics|speaker(s)?|mic|screen|projector|lighting|can'?t see|sightline)\b/i],
  },
  {
    category: "staff_service",
    patterns: [/\b(staff|bouncer|security|bartender|server|rude|helpful|attitude|ignored us|no one (was )?(there|around))\b/i],
  },
  {
    category: "food_drink",
    patterns: [/\b(bar|drink(s)?|beer|wine|cocktail|food|snack|menu|overpriced|ran out|sold out|water)\b/i],
  },
  {
    category: "wayfinding",
    patterns: [/\b(sign(s|age)?|where is|which room|lost|couldn'?t find|directions|map|confusing layout)\b/i],
  },
  {
    category: "technical",
    patterns: [/\b(app|wifi|wi-fi|signal|payment|card machine|qr|check.?in (failed|broken)|ticket(ing)? (issue|problem|broken)|crashed)\b/i],
  },
]

const POSITIVE = /\b(amazing|incredible|brilliant|great|awesome|loved?|lovely|perfect|excellent|fantastic|smooth|worth it|best|superb|nailed it|take a bow)\b/i
const NEGATIVE = /\b(awful|terrible|horrible|worst|shocking|disgusting|appalling|ridiculous|shambles|disaster|nightmare|never again|waste of)\b/i
const NEGATION = /\b(not|no|never|isn'?t|wasn'?t|aren'?t|didn'?t|don'?t|can'?t|couldn'?t|won'?t)\b/i

/**
 * Sarcasm and understatement are exactly what a lexicon cannot see — "great,
 * only queued 40 minutes" scores positive on the word and negative in reality.
 * These force an escalation rather than a guess.
 */
const AMBIGUITY_MARKERS = [
  /\blol\b|\bhaha\b|😂|🙃|🙄/i,
  /\bonly\b.*\b(hour|hours|min|mins|minutes)\b/i,
  /\bsure\b|\byeah right\b|\bapparently\b|\bsupposedly\b/i,
  /\bbut\b/i,
]

function detectCategory(text: string): IssueCategory | null {
  for (const { category, patterns } of CATEGORY_CUES) {
    if (patterns.some((p) => p.test(text))) return category
  }
  return null
}

/**
 * Returns a confident classification, or null meaning "escalate to tier 3".
 *
 * Null is the safe answer and should be returned liberally — a null costs one
 * slot in a batched LLM call; a wrong label costs the organiser's trust in the
 * whole digest.
 */
export function classifyWithLexicon(text: string): Classification | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // Anything that looks like a safety report goes to tier 3 for a real read,
  // even though the cue matched — this is the one category where a false
  // negative is unacceptable and a lexicon is not enough to clear it.
  const category = detectCategory(trimmed)
  if (category === "safety_conduct") return null

  if (AMBIGUITY_MARKERS.some((p) => p.test(trimmed))) return null

  const positive = POSITIVE.test(trimmed)
  const negative = NEGATIVE.test(trimmed)
  const negated = NEGATION.test(trimmed)

  // Both polarities present, or a negation that could invert one — escalate
  // rather than pick.
  if (positive && negative) return null
  if ((positive || negative) && negated) return null

  let sentiment: Sentiment | null = null
  if (positive) sentiment = "positive"
  else if (negative) sentiment = "negative"

  // No polarity signal AND no category cue is the case this tier exists for:
  // plain logistics chatter, confidently neutral, no LLM needed.
  if (!sentiment && !category) {
    return { sentiment: "neutral", category: "other", confidence: 0.8, source: "lexicon" }
  }

  // A category cue but no clear polarity is genuinely ambiguous — "the bar" is
  // not a complaint on its own.
  if (!sentiment) return null

  return {
    sentiment,
    category: category ?? "other",
    // Deliberately capped below what tier 3 can claim. A lexicon should never
    // present as more certain than a model that actually read the sentence.
    confidence: 0.7,
    source: "lexicon",
  }
}

/**
 * The best guess when tier 3 is unavailable. Never null.
 *
 * ## The false negative this exists to stop
 *
 * `classifyWithLexicon` returns null for a `safety_conduct` cue **on purpose**,
 * to force a real read — the comment above says a false negative there is
 * unacceptable and a lexicon is not enough to clear it. Both true.
 *
 * But when tier 3 cannot answer, `classifyMessages` wrote a hardcoded
 * `neutral / other / 0.2`, so the detection was computed and thrown away. And
 * `deriveAlerts` fires the safety alert on `category === "safety_conduct"`, so
 * **without `OPENAI_API_KEY` the safety alert could not fire at all** — while
 * `lib/env.ts` marks that key optional and `DEPLOYMENT.md` lists it as not
 * required. The ordinary deployment had a safety alert that was wired to
 * nothing.
 *
 * A low-confidence "this looks like a safety report" is a far better answer
 * than a confident "this is neutral chatter". Escalating on a maybe costs an
 * organiser a glance; missing it costs what this whole screen exists for.
 *
 * Confidence 0.3: visibly uncertain, and deliberately below the 0.7 a matched
 * lexicon rule claims, so the digest can present it differently.
 */
export function lexiconFallback(text: string): Classification {
  const category = detectCategory(text.trim())

  if (category === "safety_conduct") {
    return {
      sentiment: "negative",
      category: "safety_conduct",
      confidence: 0.3,
      source: "lexicon",
    }
  }

  return {
    // Neutral rather than a guessed polarity: this path is reached because the
    // polarity was ambiguous, negated, or absent, and inventing one would
    // flatten the mood bar with noise.
    sentiment: "neutral",
    category: category ?? "other",
    confidence: 0.3,
    source: "lexicon",
  }
}
