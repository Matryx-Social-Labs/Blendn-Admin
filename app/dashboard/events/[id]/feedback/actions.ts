"use server"

import { revalidatePath } from "next/cache"
import type { feedback_sentiment, issue_category } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { chatClosesAt } from "@/lib/chat-window"
import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"

export interface FeedbackMessage {
  id: string
  /** Pseudonym only. The real name never leaves the server for a host. */
  pseudonym: string
  at: string
  text: string
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
  categories: Array<{ category: string; count: number }>
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
  if (!eventPermissions(session.user, event).canOperate) return null

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

  const counts = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  for (const row of feedback) {
    counts[row.sentiment] += 1
    // Only what needs attention — a breakdown of the compliments is not a
    // to-do list.
    if (row.sentiment === "negative" || row.category === "safety_conduct") {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
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
    categories: Array.from(categoryCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    ratings,
    averageRating:
      event.ratings.length === 0
        ? null
        : Math.round((ratingTotal / event.ratings.length) * 10) / 10,
    messages: feedback.map((row) => ({
      id: row.id,
      pseudonym: pseudonyms.get(row.message.user_id) ?? "Attendee",
      at: row.message.created_at.toISOString(),
      text: row.message.content,
      sentiment: row.sentiment,
      category: row.category,
      confidence: row.confidence,
      corrected: row.corrected_at !== null,
    })),
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
  if (!eventPermissions(session.user, row.event).canOperate) {
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
