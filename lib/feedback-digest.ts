// Relative imports, like the rest of lib/.
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { chatClosesAt } from "./chat-window"
import { db } from "./db"
import { discloseBreakdown, discloseCategories, discloseHeadcount, discloseStars, mayQuote, publishedRaters, spreadsByEventId, type DisclosedCategory, type StarSpread } from "./disclosure"
import { publishedRatingGroups } from "./rating-batches"
import { escalates } from "./sentiment/taxonomy"

/*
 * The post-event feedback digest, built for whoever operates the event —
 * moved here from the page's server actions (step 15) so the page builds it
 * from the event its loader already read, rather than reading it twice, and
 * so no exported builder becomes a callable server action that skips the
 * permission check.
 */

/** Quotes per page of "What people said" (G8: the list was unbounded). */
export const QUOTES_PER_PAGE = 20

export interface FeedbackMessage {
  id: string
  /**
   * The start of the hour it was said in, in the event's own zone (owner
   * approval 7, 2026-11-12). No pseudonym and no minute: a room-stable name
   * and the exact time beside a sentence was the one place a host read
   * individual words against a person.
   */
  hour: string
  text: string
  sentiment: feedback_sentiment
  category: issue_category
  confidence: number
  corrected: boolean
}

export interface FeedbackDigest {
  /**
   * `venue` for the owner of the building watching another host's night:
   * every count of people (the split, the total, the raters, a category)
   * held back under the floor, as on every other venue surface (step 15).
   */
  view: "host" | "venue"
  eventTitle: string
  endedAt: string
  /** The event's own zone: its times are told in it (SCRUM-421). */
  timezone: string
  /** False while the room is still live — the tab is reachable before the end. */
  ended: boolean
  windowClosesAt: string
  windowOpen: boolean
  /** Null where held back for a venue: the breakdown rule (`discloseBreakdown`). */
  counts: { positive: number | null; neutral: number | null; negative: number | null }
  /** Messages classified, or null for a venue once any mood is held back. */
  total: number | null
  categories: DisclosedCategory[]
  /** All zero, and the average null, until `MIN_CELL` people have rated. */
  ratings: [number, number, number, number, number]
  averageRating: number | null
  /** How many rated, so a screen can say "not enough yet" — null under the floor for a venue. */
  ratingCount: number | null
  /**
   * New ratings not in the bars yet, of the `RATING_BATCH` that move them (SCRUM-472): 0, 1 or 2 from the floor up, for
   * a host. Null under the floor and for a venue, whose count stays at the published figure.
   */
  ratingsTowardNextUpdate: number | null
  /**
   * Only what can be quoted: a row held back would still say its mood and
   * category, in feed order (SCRUM-890). One page, earliest first.
   */
  messages: FeedbackMessage[]
  /** Quotable rows on every page together (0 for a venue). */
  messagesTotal: number
  /** The page `messages` is, clamped to the ones that exist. */
  messagesPage: number
}

export async function buildFeedbackDigest(
  event: { id: string; title: string; end_time: Date; timezone: string },
  view: "host" | "venue",
  page = 1
): Promise<FeedbackDigest> {
  const eventId = event.id
  const [ratingGroups, raters] = await Promise.all([
    publishedRatingGroups({ id: eventId }),
    db.event_ratings.count({ where: { event_id: eventId } }),
  ])
  // What the tally needs, and nothing it does not: the words are read below, one page of them.
  const feedback = await db.event_feedback.findMany({
    where: { event_id: eventId },
    select: { sentiment: true, category: true, message: { select: { user_id: true } } },
  })

  /*
   * The room's size, asked by the event (one room per event): after the
   * 180-day purge a feedback row has no message to reach it through. No
   * pseudonym is read at all: a quote carries none (approval 7).
   */
  const [members, frozen] = await Promise.all([
    db.chat_group_members.count({ where: { chat_group: { event_id: eventId } } }),
    db.event_feedback_tallies.findUnique({ where: { event_id: eventId }, select: { population: true, contributors: true } }),
  ])

  const tally = tallyFeedback(feedback.map((row) => ({ sentiment: row.sentiment, category: row.category, userId: row.message?.user_id ?? null })))
  const { counts, categoryCounts } = tally
  /*
   * How many people are in the room, and how many said something in each
   * category: the denominators every suppression rule below needs. Once the
   * purge has frozen them (it does so before the first message goes, while
   * every author is still known), they are read from there, so the figures
   * after the purge are the figures before it.
   */
  const population = frozen?.population ?? members
  const categoryContributors = frozen ? new Map(Object.entries(frozen.contributors as Record<string, number>)) : tally.contributors

  // The categories a quote may come from: the same rule, per category, as before.
  const quotable = [...categoryContributors]
    .filter(([, contributors]) => mayQuote({ contributors, population }))
    .map(([category]) => category as issue_category)

  const ratings: StarSpread = spreadsByEventId(ratingGroups).get(eventId) ?? [0, 0, 0, 0, 0]

  const closesAt = chatClosesAt({ end_time: event.end_time })

  const venue = view === "venue"
  /*
   * A venue's split is a breakdown with a shared total, so it goes through the
   * breakdown rule: every mood under five held back, a lone survivor held back
   * with them, and no total once anything is. Flooring each mood alone was not
   * enough — the total minus the shown moods gave the held-back one back, which
   * the staging drive of step 15 read off the page ("20 messages", "19
   * neutral", "0 negative": one positive).
   */
  const split = venue ? discloseBreakdown([counts.positive, counts.neutral, counts.negative]) : null
  const stars = discloseStars(ratings)

  return {
    view,
    eventTitle: event.title,
    endedAt: event.end_time.toISOString(),
    timezone: event.timezone,
    windowClosesAt: closesAt.toISOString(),
    windowOpen: Date.now() < closesAt.getTime(),
    ended: Date.now() >= event.end_time.getTime(),
    counts: split ? { positive: split.cells[0], neutral: split.cells[1], negative: split.cells[2] } : counts,
    total: split ? split.total : counts.positive + counts.neutral + counts.negative,
    /*
     * Counts, suppressed below the disclosure floor.
     *
     * A category is still LISTED when suppressed -- an organiser needs to know
     * a safety concern was raised -- but the number is null, because "1
     * safety_conduct" in a room of six is a sentence with an author.
     */
    categories: discloseCategories(categoryCounts, categoryContributors, population),
    // The stars too: under five raters they are individual scores (SCRUM-437).
    ...stars,
    ratingCount: venue ? discloseHeadcount(stars.ratingCount) : raters,
    ratingsTowardNextUpdate: !venue && stars.averageRating !== null ? raters - publishedRaters(raters) : null,
    /*
     * The sharpest finding in the audit, and the one this module was written
     * for.
     *
     * This handed an organiser verbatim message text with a **room-stable**
     * pseudonym and an exact timestamp, with no minimum cell at all. In a
     * six-person room, one `safety_conduct` message names its author to
     * somebody who has seen that pseudonym all night -- and a safety concern is
     * the one thing an attendee most needs not to be identified for raising.
     *
     * A quote cannot be partially suppressed, so its whole row goes: its mood in
     * feed order ties each message to a place in the room's feed (SCRUM-890). The
     * organiser still learns it was raised, from the category's total above.
     */
    /*
     * None for a venue. Each row carries its mood and its category even when
     * the quote is held back, so a list of them is the split again, row by
     * row. The venue reads what was said where it was said: the Room chat it
     * moderates.
     */
    ...(venue ? { messages: [], messagesTotal: 0, messagesPage: 1 } : await quotePage(eventId, event.timezone, quotable, page)),
  }
}

/** A feedback row as the tally reads it: `userId` is null once the purge has detached its message. */
export interface TallyRow {
  sentiment: feedback_sentiment
  category: issue_category
  userId: string | null
}

/**
 * Moods, and the categories that need attention with how many distinct
 * **people** raised each — not messages: a category is identifying when few
 * people contributed to it, and one person posting six complaints is one
 * person, so counting messages would let a single upset attendee unlock their
 * own quotes. Only negatives and the escalating set are broken down (a
 * breakdown of the compliments is not a to-do list), asked for by name so the
 * live screen and this digest cannot drift apart. One rule for the digest, the
 * live screen and the purge's frozen tally.
 */
export function tallyFeedback(rows: readonly TallyRow[]) {
  const counts = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  const people = new Map<string, Set<string>>()
  for (const row of rows) {
    counts[row.sentiment] += 1
    if (row.sentiment !== "negative" && !escalates(row.category)) continue
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    const who = people.get(row.category) ?? new Set<string>()
    if (row.userId) who.add(row.userId)
    people.set(row.category, who)
  }
  const contributors = new Map([...people].map(([category, who]) => [category, who.size]))
  return { counts, categoryCounts, contributors }
}

/**
 * One page of quotes, earliest first, from the categories that may be quoted.
 * A purged row has no words and no author, so it is never a quote. Bounded:
 * at most `QUOTES_PER_PAGE` rows of text are ever read.
 */
async function quotePage(eventId: string, timezone: string, quotable: issue_category[], page: number) {
  const where = { event_id: eventId, category: { in: quotable }, message_id: { not: null } }
  const messagesTotal = quotable.length ? await db.event_feedback.count({ where }) : 0
  const last = Math.max(1, Math.ceil(messagesTotal / QUOTES_PER_PAGE))
  const messagesPage = Number.isFinite(page) ? Math.min(Math.max(1, Math.floor(page)), last) : 1
  if (messagesTotal === 0) return { messages: [], messagesTotal, messagesPage }
  const rows = await db.event_feedback.findMany({
    where,
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    skip: (messagesPage - 1) * QUOTES_PER_PAGE,
    take: QUOTES_PER_PAGE,
    select: { id: true, sentiment: true, category: true, confidence: true, corrected_at: true, message: { select: { content: true, created_at: true } } },
  })
  const messages: FeedbackMessage[] = rows.flatMap((row) =>
    row.message
      ? [{
          id: row.id,
          hour: hourOf(row.message.created_at, timezone).toISOString(),
          text: row.message.content,
          sentiment: row.sentiment,
          category: row.category,
          confidence: row.confidence,
          corrected: row.corrected_at !== null,
        }]
      : []
  )
  return { messages, messagesTotal, messagesPage }
}

/** The start of the hour `at` falls in, on the clock of `timeZone` (whose offset may be a half or quarter hour). */
export function hourOf(at: Date, timeZone: string): Date {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone, minute: "numeric", second: "numeric" }).formatToParts(at)
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", minute: "numeric", second: "numeric" }).formatToParts(at)
  }
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return new Date(at.getTime() - (part("minute") * 60 + part("second")) * 1000 - at.getMilliseconds())
}
