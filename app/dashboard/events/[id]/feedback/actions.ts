"use server"

import { revalidatePath } from "next/cache"
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { chatClosesAt } from "@/lib/chat-window"
import { discloseFigure, mayQuote, type SuppressionReason } from "@/lib/disclosure"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"

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
  eventTitle: string
  endedAt: string
  windowClosesAt: string
  windowOpen: boolean
  counts: { positive: number; neutral: number; negative: number }
  categories: Array<{
    category: string
    /** Null when suppressed. The category is still listed. */
    count: number | null
    suppressed: boolean
    suppressionReason: SuppressionReason | null
  }>
  ratings: [number, number, number, number, number]
  averageRating: number | null
  messages: FeedbackMessage[]
}

/**
 * Everything the post-event digest needs, in one read.
 *
 * Gated on operational access, so the owner of the venue it was held at sees it
 * too — they have as much to learn from "the bar queue was the worst I've seen"
 * as the organiser does.
 */
export async function getFeedbackDigest(eventId: string): Promise<FeedbackDigest | null> {
  const session = await getAuth()
  if (!session?.user) return null

  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: {
      ...eventPermissionSelect,
      title: true,
      end_time: true,
      ratings: { select: { rating: true } },
    },
  })
  if (!event) return null
  if (!eventPermissions(await actorFor(session.user), event).canOperate) return null

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
    // to-do list.
    if (row.sentiment === "negative" || row.category === "safety_conduct") {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
      const people = categoryContributors.get(row.category) ?? new Set<string>()
      people.add(row.message.user_id)
      categoryContributors.set(row.category, people)
    }
  }

  const ratings: [number, number, number, number, number] = [0, 0, 0, 0, 0]
  for (const { rating } of event.ratings) {
    if (rating >= 1 && rating <= 5) ratings[rating - 1] += 1
  }
  const ratingTotal = event.ratings.reduce((sum, r) => sum + r.rating, 0)

  const closesAt = chatClosesAt({ end_time: event.end_time })

  return {
    eventTitle: event.title,
    endedAt: event.end_time.toISOString(),
    windowClosesAt: closesAt.toISOString(),
    windowOpen: Date.now() < closesAt.getTime(),
    counts,
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
        return {
          category,
          count: disclosure.value,
          suppressed: disclosure.suppressed,
          suppressionReason: disclosure.reason,
        }
      })
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    ratings,
    averageRating:
      event.ratings.length === 0
        ? null
        : Math.round((ratingTotal / event.ratings.length) * 10) / 10,
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

/**
 * Correct a label.
 *
 * A designed affordance rather than an escape hatch: the classifier is wrong
 * about sarcasm often enough that "great, only queued 40 minutes" is a routine
 * case, not an edge one. The correction becomes the record — `source: human`,
 * highest confidence — and is kept for future tuning.
 */
export async function correctFeedbackLabel(
  feedbackId: string,
  sentiment: feedback_sentiment,
  category: issue_category
) {
  const session = await getAuth()
  if (!session?.user) throw new Error("Not authenticated")

  const row = await db.event_feedback.findUnique({
    where: { id: feedbackId },
    select: {
      event_id: true,
      event: { select: eventPermissionSelect },
    },
  })
  if (!row) throw new Error("Feedback not found")
  if (!eventPermissions(await actorFor(session.user), row.event).canOperate) {
    throw new Error("Not authorised to correct this label")
  }

  await db.event_feedback.update({
    where: { id: feedbackId },
    data: {
      sentiment,
      category,
      source: "human",
      confidence: 1,
      corrected_by: session.user.id,
      corrected_at: new Date(),
    },
  })

  auditLog({
    userId: session.user.id,
    action: "feedback.label_corrected",
    resource: "event_feedback",
    resourceId: feedbackId,
    details: { sentiment, category },
  })

  revalidatePath(`/dashboard/events/${row.event_id}/feedback`)
}
