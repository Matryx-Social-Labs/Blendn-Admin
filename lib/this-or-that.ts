import type { ListCountry } from "./about-you"

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
  /** Asked only in these countries (market codes); absent: asked everywhere, the neutral set included. */
  only?: readonly ListCountry[]
}

export type Choice = "a" | "b"

const IN: readonly ListCountry[] = ["IN"]
const CA: readonly ListCountry[] = ["CA"]

export const THIS_OR_THAT: readonly ThisOrThat[] = [
  { slug: "coffee_or_chai", a: { label: "Filter coffee ☕", phrase: "filter coffee" }, b: { label: "Chai 🫖", phrase: "chai" }, only: IN },
  {
    slug: "sunrise_or_late_walk",
    a: { label: "Nandi Hills sunrise", phrase: "a Nandi Hills sunrise" },
    // Never a neighbourhood: where you walk at 2am is where you live (Tier C, step 10 review L5).
    b: { label: "2am city walk", phrase: "a 2am walk through the city" },
    only: IN,
  },
  { slug: "metro_or_auto", a: { label: "Metro", phrase: "the metro" }, b: { label: "Auto", phrase: "an auto" }, only: IN },
  { slug: "plan_or_wing_it", a: { label: "Plan everything", phrase: "planning everything" }, b: { label: "Wing it", phrase: "winging it" } },
  { slug: "concert_or_standup", a: { label: "Concert", phrase: "a concert" }, b: { label: "Stand-up", phrase: "stand-up" } },
  { slug: "mountains_or_beaches", a: { label: "Mountains", phrase: "the mountains" }, b: { label: "Beaches", phrase: "the beach" } },
  { slug: "early_or_night", a: { label: "Early bird", phrase: "early mornings" }, b: { label: "Night owl", phrase: "late nights" } },
  {
    slug: "cup_namdu_or_no_cricket",
    a: { label: "Ee sala cup namdu", phrase: "ee sala cup namdu" },
    b: { label: "I don’t watch cricket", phrase: "not watching cricket" },
    only: IN,
  },
  { slug: "window_or_aisle", a: { label: "Window seat", phrase: "the window seat" }, b: { label: "Aisle", phrase: "the aisle" } },
  { slug: "text_or_voice", a: { label: "Text", phrase: "texting" }, b: { label: "Voice note", phrase: "voice notes" } },
  { slug: "bollywood_or_techno", a: { label: "Bollywood night", phrase: "a Bollywood night" }, b: { label: "Techno night", phrase: "a techno night" }, only: IN },
  { slug: "board_games_or_quiz", a: { label: "Board games", phrase: "board games" }, b: { label: "Pub quiz", phrase: "a pub quiz" } },
  /*
   * Canada's own (SCRUM-711), after India's so India's list keeps its order.
   * The same rules: no meat, no alcohol, no faith; "I don't watch hockey" is as
   * honest as the cricket one.
   */
  {
    slug: "hockey_or_no_hockey",
    a: { label: "Hockey night 🏒", phrase: "hockey night" },
    b: { label: "I don’t watch hockey", phrase: "not watching hockey" },
    only: CA,
  },
  { slug: "cottage_or_city", a: { label: "Cottage weekend", phrase: "a cottage weekend" }, b: { label: "City weekend", phrase: "a city weekend" }, only: CA },
  { slug: "winter_or_summer", a: { label: "Winter person ❄️", phrase: "winter" }, b: { label: "Summer person ☀️", phrase: "summer" }, only: CA },
] as const

const BY_SLUG = new Map(THIS_OR_THAT.map((q) => [q.slug, q]))

/** The questions a country's people are asked, in order; for null (neutral), only the ones asked everywhere. */
export const thisOrThatFor = (country: ListCountry | null): readonly ThisOrThat[] =>
  THIS_OR_THAT.filter((q) => !q.only || (country !== null && q.only.includes(country)))

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
