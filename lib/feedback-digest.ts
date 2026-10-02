// Relative imports, like the rest of lib/.
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { chatClosesAt } from "./chat-window"
import { db } from "./db"
import { discloseFigure, discloseHeadcount, discloseStars, mayQuote, MIN_CELL as MIN_CELL_VENUE, type SuppressionReason } from "./disclosure"
import { escalates } from "./sentiment/taxonomy"

/*
 * The post-event feedback digest, built for whoever operates the event —
 * moved here from the page's server actions (step 15) so the page builds it
 * from the event its loader already read, rather than reading it twice, and
 * so no exported builder becomes a callable server action that skips the
 * permission check.
 */

export interface FeedbackMessage {
  id: string
  /**
   * Pseudonym only, and **null when the quote is suppressed**.
   *
   * The real name never leaves the server for a host. Below the disclosure
   * floor the pseudonym goes too: it is room-stable, so an organiser who has
   * seen it all night learns as much from the label as from the name.
   */
  pseudonym: string | null
  /** Null with the text. A timestamp plus a room-stable pseudonym identifies. */
  at: string | null
  /** Null when the category has too few contributors to quote from. */
  text: string | null
  /** The label survives suppression; the organiser still learns it was raised. */
  suppressed: boolean
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
  /** Null under the floor for a venue. Zero is shown: it identifies nobody. */
  counts: { positive: number | null; neutral: number | null; negative: number | null }
  /** Messages classified, or null under the floor for a venue. */
  total: number | null
  categories: Array<{
    category: string
    /** Null when suppressed. The category is still listed. */
    count: number | null
    suppressed: boolean
    suppressionReason: SuppressionReason | null
  }>
  /** All zero, and the average null, until `MIN_CELL` people have rated. */
  ratings: [number, number, number, number, number]
  averageRating: number | null
  /** How many rated, so a screen can say "not enough yet" — null under the floor for a venue. */
  ratingCount: number | null
  messages: FeedbackMessage[]
}

export async function buildFeedbackDigest(
  event: { id: string; title: string; end_time: Date; timezone: string },
  view: "host" | "venue"
): Promise<FeedbackDigest> {
  const eventId = event.id
  const ratingRows = await db.event_ratings.findMany({ where: { event_id: eventId }, select: { rating: true } })
  const feedback = await db.event_feedback.findMany({
    where: { event_id: eventId },
    orderBy: { created_at: "asc" },
    select: {
      id: true,
      sentiment: true,
      category: true,
      confidence: true,
      corrected_at: true,
      message: {
        select: {
          content: true,
          created_at: true,
          user_id: true,
          chat_group: { select: { id: true } },
        },
      },
    },
  })

  /*
   * Pseudonyms are resolved server-side and the real user id never reaches the
   * response. Sending the id and letting the client render a name would be the
   * same mistake as the chat route made — the UI looked anonymous while the
   * payload was not.
   */
  const chatGroupId = feedback[0]?.message.chat_group?.id
  const members = chatGroupId
    ? await db.chat_group_members.findMany({
        where: { chat_group_id: chatGroupId },
        select: { user_id: true, anonymous_name: true },
      })
    : []
  const pseudonyms = new Map(members.map((m) => [m.user_id, m.anonymous_name]))

  /*
   * How many people are in the room. The denominator every suppression rule
   * below needs, and the reason this digest had none.
   */
  const population = members.length

  const counts = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  /*
   * Distinct **people** per category, not messages. A category is identifying
   * when few people contributed to it, and one person posting six complaints is
   * one person -- counting messages would let a single upset attendee unlock
   * their own quotes.
   */
  const categoryContributors = new Map<string, Set<string>>()
  for (const row of feedback) {
    counts[row.sentiment] += 1
    // Only what needs attention — a breakdown of the compliments is not a
    // to-do list. Same escalating set as the live screen, asked for by name so
    // the two cannot drift apart.
    if (row.sentiment === "negative" || escalates(row.category)) {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
      const people = categoryContributors.get(row.category) ?? new Set<string>()
      people.add(row.message.user_id)
      categoryContributors.set(row.category, people)
    }
  }

  const ratings: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const { rating } of ratingRows) {
    if (rating >= 1 && rating <= 5) ratings[rating - 1] += 1
  }

  const closesAt = chatClosesAt({ end_time: event.end_time })

  const venue = view === "venue"
  const total = counts.positive + counts.neutral + counts.negative
  const shownTotal = venue ? discloseHeadcount(total) : total
  const stars = discloseStars(ratings)

  return {
    view,
    eventTitle: event.title,
    endedAt: event.end_time.toISOString(),
    timezone: event.timezone,
    windowClosesAt: closesAt.toISOString(),
    windowOpen: Date.now() < closesAt.getTime(),
    ended: Date.now() >= event.end_time.getTime(),
    // Under the floor the split is a few people's moods; a venue gets none of it.
    counts:
      venue && shownTotal === null
        ? { positive: null, neutral: null, negative: null }
        : venue
          ? { positive: discloseHeadcount(counts.positive), neutral: discloseHeadcount(counts.neutral), negative: discloseHeadcount(counts.negative) }
          : counts,
    total: shownTotal,
    /*
     * Counts, suppressed below the disclosure floor.
     *
     * A category is still LISTED when suppressed -- an organiser needs to know
     * a safety concern was raised -- but the number is null, because "1
     * safety_conduct" in a room of six is a sentence with an author.
     */
    categories: Array.from(categoryCounts.entries())
      .map(([category, count]) => {
        const disclosure = discloseFigure({
          count,
          contributors: categoryContributors.get(category)?.size ?? 0,
          population,
        })
        // A venue gets no count under the floor, whatever the room's size.
        const shown = venue && disclosure.value !== null && disclosure.value < MIN_CELL_VENUE ? null : disclosure.value
        return {
          category,
          count: shown,
          suppressed: shown === null,
          suppressionReason: shown === null ? (disclosure.reason ?? ("min_cell" as const)) : null,
        }
      })
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    // The stars too: under five raters they are individual scores (SCRUM-437).
    ...stars,
    ratingCount: venue ? discloseHeadcount(stars.ratingCount) : stars.ratingCount,
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
     * A quote cannot be partially suppressed, so the text goes and the label
     * stays: the organiser still learns that somebody raised it, in which
     * category, without learning who. The timestamp goes with the text, because
     * "22:14" plus a room-stable pseudonym is the same identification by
     * another route.
     */
    messages: feedback.map((row) => {
      const quotable = mayQuote({
        contributors: categoryContributors.get(row.category)?.size ?? 0,
        population,
      })
      return {
        id: row.id,
        pseudonym: quotable ? (pseudonyms.get(row.message.user_id) ?? "Attendee") : null,
        at: quotable ? row.message.created_at.toISOString() : null,
        text: quotable ? row.message.content : null,
        suppressed: !quotable,
        sentiment: row.sentiment,
        category: row.category,
        confidence: row.confidence,
        corrected: row.corrected_at !== null,
      }
    }),
  }
}

