/**
 * What attendees complain about at live events.
 *
 * Sentiment alone is not actionable: "12 negative" tells an organiser nothing
 * they can act on. "9 of 12 are the bar queue" tells them to open another bar.
 * So every classified message carries a category as well as a polarity.
 *
 * The set is drawn from live-event operations research rather than invented.
 * Crowd mismanagement is the single largest cause of venue incidents (~45% in
 * 2023), with queueing and bottlenecks, wayfinding confusion, and technical
 * failures the other recurring themes. Keeping it small matters — a taxonomy
 * with thirty labels gets used inconsistently by both the classifier and the
 * humans correcting it.
 */
export const ISSUE_CATEGORIES = [
  /** Doors, entry lines, ID checks, slow scanning. */
  "entry_queue",
  /** Density inside, bottlenecks, crush, cannot move. */
  "crowding",
  /** Toilets, temperature, cleanliness, seating, accessibility. */
  "facilities",
  /** Volume, mix quality, sightlines, screens, lighting. */
  "sound_av",
  /** Staff conduct, absence, slowness at the bar or desk. */
  "staff_service",
  /** Availability, price, quality of food and drink. */
  "food_drink",
  /** Signage, finding rooms, unclear timings or directions. */
  "wayfinding",
  /** App, check-in, payment, wifi, ticketing failures. */
  "technical",
  /** Harassment, threats, aggression, someone unwell or unsafe. */
  "safety_conduct",
  /** Genuinely uncategorised. Not a dumping ground for "unsure". */
  "other",
] as const

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number]

export const SENTIMENTS = ["positive", "neutral", "negative"] as const
export type Sentiment = (typeof SENTIMENTS)[number]

/**
 * Categories that escalate regardless of how the message reads.
 *
 * A calmly-worded report of someone being followed is not a "negative
 * sentiment data point", it is a safety incident. Routing on category rather
 * than tone means a composed message is not deprioritised for being composed.
 */
export const ESCALATING_CATEGORIES: readonly IssueCategory[] = ["safety_conduct"]

export function escalates(category: IssueCategory): boolean {
  return ESCALATING_CATEGORIES.includes(category)
}

export interface Classification {
  sentiment: Sentiment
  category: IssueCategory
  /** 0-1. Drives whether the UI presents this as certain or as a guess. */
  confidence: number
  /**
   * Which tier produced it. Surfaced in the UI: a lexicon label and an LLM
   * label should not look equally authoritative, because they are not.
   */
  source: "lexicon" | "llm" | "human"
}

export function isIssueCategory(value: string): value is IssueCategory {
  return (ISSUE_CATEGORIES as readonly string[]).includes(value)
}

export function isSentiment(value: string): value is Sentiment {
  return (SENTIMENTS as readonly string[]).includes(value)
}
