import { db } from "@/lib/db"

import type { LiveSnapshot } from "./live-metrics"

const MINUTE = 60 * 1000

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Compute one snapshot.
 *
 * Read directly rather than kept in memory: a counter held in the process is
 * wrong after any restart, and wrong in a way nobody notices until an alert
 * fails to fire. The queries are all indexed and scoped to one event.
 */
export async function buildLiveSnapshot(eventId: string): Promise<LiveSnapshot | null> {
  const now = new Date()
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: {
      id: true,
      start_time: true,
      max_capacity: true,
      chat_group: { select: { id: true } },
    },
  })
  if (!event) return null

  const tenMinutesAgo = new Date(now.getTime() - 10 * MINUTE)
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * MINUTE)
  const chatGroupId = event.chat_group?.id

  const [checkIns, recentMessages, activeChatters, openFlags, feedback] = await Promise.all([
    db.event_check_ins.findMany({
      where: { event_id: eventId },
      select: { check_in_time: true, check_out_time: true, status: true },
    }),
    chatGroupId
      ? db.chat_messages.count({
          where: {
            chat_group_id: chatGroupId,
            deleted_at: null,
            created_at: { gte: tenMinutesAgo },
          },
        })
      : Promise.resolve(0),
    chatGroupId
      ? db.chat_messages
          .findMany({
            where: {
              chat_group_id: chatGroupId,
              deleted_at: null,
              created_at: { gte: thirtyMinutesAgo },
            },
            select: { user_id: true },
            distinct: ["user_id"],
          })
          .then((rows) => rows.length)
      : Promise.resolve(0),
    chatGroupId
      ? db.moderation_flags.count({ where: { chat_group_id: chatGroupId, status: "pending" } })
      : Promise.resolve(0),
    db.event_feedback.findMany({
      where: { event_id: eventId, created_at: { gte: thirtyMinutesAgo } },
      select: { sentiment: true, category: true },
    }),
  ])

  const checkedInTotal = checkIns.filter(
    (c) => c.status === "checked_in" || c.status === "checked_out"
  ).length
  const checkedOutTotal = checkIns.filter((c) => c.check_out_time !== null).length
  const inside = Math.max(0, checkedInTotal - checkedOutTotal)

  const checkInRate10m = checkIns.filter(
    (c) => c.check_in_time && c.check_in_time >= tenMinutesAgo
  ).length

  /*
   * Median of every completed 10-minute bucket since doors. The rate alone says
   * nothing — 31 arrivals is a stampede for a book club and a slow night for a
   * festival — so the alert compares against this event's own baseline.
   */
  const buckets: number[] = []
  const doors = event.start_time
  for (let t = doors.getTime(); t + 10 * MINUTE <= now.getTime(); t += 10 * MINUTE) {
    const from = new Date(t)
    const to = new Date(t + 10 * MINUTE)
    buckets.push(
      checkIns.filter((c) => c.check_in_time && c.check_in_time >= from && c.check_in_time < to)
        .length
    )
  }

  const sentiment = { positive: 0, neutral: 0, negative: 0 }
  const categoryCounts = new Map<string, number>()
  for (const row of feedback) {
    sentiment[row.sentiment] += 1
    // Only what needs attention: positives by category are noise on a live
    // screen whose job is surfacing problems.
    if (row.sentiment === "negative" || row.category === "safety_conduct") {
      categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1)
    }
  }

  return {
    eventId,
    at: now.toISOString(),
    inside,
    checkedInTotal,
    checkedOutTotal,
    capacity: event.max_capacity,
    fillPct:
      event.max_capacity && event.max_capacity > 0
        ? Math.min(100, (inside / event.max_capacity) * 100)
        : null,
    checkInRate10m,
    medianRate10m: median(buckets),
    messagesPerMinute: Math.round((recentMessages / 10) * 10) / 10,
    activeChatters30m: activeChatters,
    openFlags,
    sentiment,
    categories: Array.from(categoryCounts.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
  }
}

