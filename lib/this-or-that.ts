/**
 * This-or-that: twelve Bengaluru questions with two answers each (plan v2
 * §8.3, research §6.5). The best icebreaker per byte — "you both picked filter
 * coffee over chai" — and **display only** until four weeks of data say which
 * answers precede a mutual like (§8.8 step 6). Nothing here is scored.
 *
 * Constants, not rows: twelve questions change by a deploy, and the answers
 * table (`this_or_that_answers`) keys on the slug. A retired question's
 * answers stop showing because nothing here names them.
 *
 * Every pair is chosen to proxy nothing: no side is meat or alcohol, no
 * festival, no English-medium against vernacular, no college. "I don't watch
 * cricket" is an honest answer, not a lesser one.
 *
 * `phrase` is the answer mid-sentence ("You both picked filter coffee over
 * chai"); `label` is the chip.
 */

export interface Answer {
  label: string
  phrase: string
}

export interface ThisOrThat {
  slug: string
  a: Answer
  b: Answer
}

export type Choice = "a" | "b"

export const THIS_OR_THAT: readonly ThisOrThat[] = [
  { slug: "coffee_or_chai", a: { label: "Filter coffee ☕", phrase: "filter coffee" }, b: { label: "Chai 🫖", phrase: "chai" } },
  {
    slug: "sunrise_or_late_walk",
    a: { label: "Nandi Hills sunrise", phrase: "a Nandi Hills sunrise" },
    b: { label: "2am Koramangala walk", phrase: "a 2am Koramangala walk" },
  },
  { slug: "metro_or_auto", a: { label: "Metro", phrase: "the metro" }, b: { label: "Auto", phrase: "an auto" } },
  { slug: "plan_or_wing_it", a: { label: "Plan everything", phrase: "planning everything" }, b: { label: "Wing it", phrase: "winging it" } },
  { slug: "concert_or_standup", a: { label: "Concert", phrase: "a concert" }, b: { label: "Stand-up", phrase: "stand-up" } },
  { slug: "mountains_or_beaches", a: { label: "Mountains", phrase: "the mountains" }, b: { label: "Beaches", phrase: "the beach" } },
  { slug: "early_or_night", a: { label: "Early bird", phrase: "early mornings" }, b: { label: "Night owl", phrase: "late nights" } },
  {
    slug: "cup_namdu_or_no_cricket",
    a: { label: "Ee sala cup namdu", phrase: "ee sala cup namdu" },
    b: { label: "I don't watch cricket", phrase: "not watching cricket" },
  },
  { slug: "window_or_aisle", a: { label: "Window seat", phrase: "the window seat" }, b: { label: "Aisle", phrase: "the aisle" } },
  { slug: "text_or_voice", a: { label: "Text", phrase: "texting" }, b: { label: "Voice note", phrase: "voice notes" } },
  { slug: "bollywood_or_techno", a: { label: "Bollywood night", phrase: "a Bollywood night" }, b: { label: "Techno night", phrase: "a techno night" } },
  { slug: "board_games_or_quiz", a: { label: "Board games", phrase: "board games" }, b: { label: "Pub quiz", phrase: "a pub quiz" } },
] as const

const BY_SLUG = new Map(THIS_OR_THAT.map((q) => [q.slug, q]))

export const isQuestion = (slug: unknown): slug is string => typeof slug === "string" && BY_SLUG.has(slug)
export const isChoice = (v: unknown): v is Choice => v === "a" || v === "b"

/** The answer they picked and the one they did not, or null for a retired question. */
export function picked(slug: string, choice: string): { chose: Answer; over: Answer } | null {
  const q = BY_SLUG.get(slug)
  if (!q || !isChoice(choice)) return null
  return choice === "a" ? { chose: q.a, over: q.b } : { chose: q.b, over: q.a }
}

/** One key per answer, for counting how many in a room picked it. */
export const answerKey = (slug: string, choice: string) => `${slug}:${choice}`
