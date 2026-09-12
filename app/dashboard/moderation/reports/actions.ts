"use server"

import { revalidatePath } from "next/cache"
import type { report_status } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { emitChatMessageHidden } from "@/lib/socket-server"
import { applySuspension, liftSuspension } from "@/lib/suspension"

/**
 * What a person reported, and what an admin can do about it.
 *
 * `user_reports` and `message_reports` were written by two mobile routes and
 * read by nothing in either repository. A harassment report produced a row no
 * human was ever going to see — in a product whose stated differentiator over
 * an anonymous board is that somebody is accountable for the room.
 *
 * They live beside `moderation_flags` rather than inside it. `moderation_flags`
 * has `message_id` NOT NULL with a foreign key to `chat_messages`, so it can
 * hold neither a report about a *person* (no message) nor one about a private
 * message (wrong table). Widening it would mean a nullable FK plus a subject
 * discriminator on the busiest moderation table, to store rows that answer a
 * different question: a flag is the pipeline's opinion, a report is a person
 * asking for help.
 */

/** The queue is capped per table, and the cap is stated rather than silent. */
const PAGE = 100

export interface ReportRow {
  id: string
  kind: "user" | "message" | "event"
  ageHours: number
  reason: string
  description: string | null
  /** Real names throughout: this screen is app_admin only and exists to name people. */
  reporterName: string
  /** Who the report is about. Null when the message it names has since vanished. */
  subjectId: string | null
  subjectName: string
  subjectSuspended: boolean
  /** Message reports only. */
  excerpt: string | null
  messageType: "group" | "private" | null
  messageDeleted: boolean
  eventTitle: string | null
  eventId: string | null
  reviewedBy: string | null
}

export type ReportDecision = "dismiss" | "remove_message" | "suspend" | "reinstate" | "delist"

/**
 * `report_status` has three values and this uses two of them.
 *
 * `reviewed` means a human looked and did nothing; `resolved` means a human
 * looked and acted. Keeping them apart is the difference between "we have no
 * evidence" and "we removed it", which is exactly what gets asked about a
 * report six weeks later.
 */
const OUTCOME: Record<Exclude<ReportDecision, "reinstate">, report_status> = {
  dismiss: "reviewed",
  remove_message: "resolved",
  suspend: "resolved",
  delist: "resolved",
}

function ageHours(at: Date, now: number): number {
  return Math.floor((now - at.getTime()) / (60 * 60 * 1000))
}

function displayName(user: { name: string | null; email: string } | null): string {
  return user?.name ?? user?.email ?? "Deleted account"
}

export async function getReportQueue(status: report_status = "pending") {
  // Same reasoning as `getModerationQueue`: the page's redirect guards the
  // view, not this function. A server action is a POST endpoint dispatched by
  // action id with no page component in the path, and this one returns private
  // message content beside real names and email addresses.
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Not authorised")

  const now = Date.now()

  const [userReports, messageReports, eventReports, userCounts, messageCounts, eventCounts] =
    await Promise.all([
    db.user_reports.findMany({
      where: { status },
      // Oldest first, like the flag queue: the SLA is how long somebody has
      // been waiting for an answer, so newest-first buries the worst cases.
      orderBy: { created_at: "asc" },
      take: PAGE,
      select: {
        id: true,
        created_at: true,
        reason: true,
        description: true,
        reviewed_by: true,
        reporter: { select: { name: true, email: true } },
        reported: { select: { id: true, name: true, email: true, suspended_at: true } },
      },
    }),
    db.message_reports.findMany({
      where: { status },
      orderBy: { created_at: "asc" },
      take: PAGE,
      select: {
        id: true,
        created_at: true,
        reason: true,
        description: true,
        message_id: true,
        message_type: true,
        reviewed_by: true,
        reporter: { select: { name: true, email: true } },
      },
    }),
    /*
     * `event_reports` had zero writers and zero readers, so somebody wanting to
     * report an unsafe venue or a misleading listing had no path at all — the
     * one subject in the product with a table, indexes, and nothing at either
     * end. The mobile route now writes it; this is the other half, because a
     * report nobody sees is the same defect one step later.
     */
    db.event_reports.findMany({
      where: { status },
      orderBy: { created_at: "asc" },
      take: PAGE,
      select: {
        id: true,
        created_at: true,
        reason: true,
        description: true,
        event_id: true,
        reviewed_by: true,
        user: { select: { name: true, email: true } },
        event: { select: { id: true, title: true, visibility: true } },
      },
    }),
    db.user_reports.groupBy({ by: ["status"], _count: { _all: true } }),
    db.message_reports.groupBy({ by: ["status"], _count: { _all: true } }),
    db.event_reports.groupBy({ by: ["status"], _count: { _all: true } }),
  ])

  /*
   * `message_id` carries no foreign key — it points at one of two tables,
   * discriminated by `message_type` — so the author has to be resolved here.
   * Two queries by id set rather than one per row: a hundred reports would
   * otherwise be a hundred round trips on a page load.
   */
  const groupIds = messageReports.filter((r) => r.message_type === "group").map((r) => r.message_id)
  const privateIds = messageReports
    .filter((r) => r.message_type === "private")
    .map((r) => r.message_id)

  const [groupMessages, privateMessages] = await Promise.all([
    groupIds.length
      ? db.chat_messages.findMany({
          where: { id: { in: groupIds } },
          select: {
            id: true,
            content: true,
            deleted_at: true,
            user: { select: { id: true, name: true, email: true, suspended_at: true } },
            chat_group: { select: { event_id: true, event: { select: { title: true } } } },
          },
        })
      : [],
    privateIds.length
      ? db.private_messages.findMany({
          where: { id: { in: privateIds } },
          select: {
            id: true,
            message_text: true,
            sender: { select: { id: true, name: true, email: true, suspended_at: true } },
          },
        })
      : [],
  ])

  const groupById = new Map(groupMessages.map((m) => [m.id, m]))
  const privateById = new Map(privateMessages.map((m) => [m.id, m]))

  const rows: ReportRow[] = [
    ...userReports.map(
      (r): ReportRow => ({
        id: r.id,
        kind: "user",
        ageHours: ageHours(r.created_at, now),
        reason: r.reason,
        description: r.description,
        reporterName: displayName(r.reporter),
        subjectId: r.reported.id,
        subjectName: displayName(r.reported),
        subjectSuspended: r.reported.suspended_at !== null,
        excerpt: null,
        messageType: null,
        messageDeleted: false,
        eventTitle: null,
        eventId: null,
        reviewedBy: r.reviewed_by,
      })
    ),
    ...messageReports.map((r): ReportRow => {
      const group = groupById.get(r.message_id)
      const priv = privateById.get(r.message_id)
      const author = group?.user ?? priv?.sender ?? null
      return {
        id: r.id,
        kind: "message",
        ageHours: ageHours(r.created_at, now),
        reason: r.reason,
        description: r.description,
        reporterName: displayName(r.reporter),
        subjectId: author?.id ?? null,
        subjectName: displayName(author),
        subjectSuspended: author?.suspended_at != null,
        // A message deleted between the report and the review leaves the row
        // saying so rather than showing an empty quote.
        excerpt: (group?.content ?? priv?.message_text ?? "").slice(0, 200) || null,
        messageType: r.message_type === "private" ? "private" : "group",
        messageDeleted: group?.deleted_at != null,
        eventTitle: group?.chat_group?.event?.title ?? null,
        eventId: group?.chat_group?.event_id ?? null,
        reviewedBy: r.reviewed_by,
      }
    }),
    ...eventReports.map(
      (r): ReportRow => ({
        id: r.id,
        kind: "event",
        ageHours: ageHours(r.created_at, now),
        reason: r.reason,
        description: r.description,
        reporterName: displayName(r.user),
        /*
         * The subject is the EVENT, not a person, and `subjectId` stays null on
         * purpose so the suspend button cannot appear.
         *
         * The tempting shortcut is to treat the organiser as the subject, and
         * it is wrong here: `organizer_id` records who *created* the row, and
         * for a curated event that is the admin who ran the curation. Wiring
         * suspension to it would let a report about a listing suspend a
         * colleague. Delisting is the action that fits the subject.
         */
        subjectId: null,
        subjectName: r.event?.title ?? "Deleted event",
        subjectSuspended: false,
        excerpt: null,
        messageType: null,
        messageDeleted: false,
        eventTitle: r.event?.title ?? null,
        eventId: r.event_id,
        reviewedBy: r.reviewed_by,
      })
    ),
  ].sort((a, b) => b.ageHours - a.ageHours || a.id.localeCompare(b.id))

  const counts: Record<string, number> = {}
  for (const c of [...userCounts, ...messageCounts, ...eventCounts]) {
    counts[c.status] = (counts[c.status] ?? 0) + c._count._all
  }

  return { rows, counts, truncated: userReports.length === PAGE || messageReports.length === PAGE }
}

/**
 * Act on a report.
 *
 * Four decisions, and which ones a row offers depends on what it is about:
 *
 * - **dismiss** — a human looked and took no action. Always available.
 * - **remove_message** — soft-deletes the reported message. **Group rooms only.**
 *   `private_messages` has no `deleted_at` column, so there is nothing to set;
 *   adding one means filtering it in the socket handlers and every DM query, and
 *   it would delete evidence from a conversation only two people can see. The
 *   lever against a DM is the person, not the message.
 * - **suspend** — blocks the reported account. Enforced at every mobile token
 *   boundary (`accountBlockReason`) and their refresh tokens are revoked here,
 *   so an existing session dies within one 15-minute access token.
 * - **reinstate** — the reverse, on the same row. Suspension is meant to be
 *   reversible, and a screen that can only take the action is one nobody uses.
 */
export async function resolveReport(
  kind: "user" | "message" | "event",
  reportId: string,
  decision: ReportDecision
) {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") {
    throw new Error("Only platform admins can resolve reports")
  }

  const report =
    kind === "user"
      ? await db.user_reports.findUnique({
          where: { id: reportId },
          select: { id: true, status: true, reported_id: true },
        })
      : kind === "event"
        ? await db.event_reports.findUnique({
            where: { id: reportId },
            select: { id: true, status: true, event_id: true },
          })
        : await db.message_reports.findUnique({
            where: { id: reportId },
            select: { id: true, status: true, message_id: true, message_type: true },
          })

  if (!report) throw new Error("Report not found")
  /*
   * Two admins working the queue at once would otherwise both act on it.
   *
   * Reinstate is the exception, deliberately: it is offered on an already
   * resolved report — the reports table says so in as many words — and this
   * guard refused it, so every "Reinstate" 500'd and a suspension could only
   * be lifted by somebody with database access. Found by suspending and then
   * trying to undo it.
   */
  if (decision !== "reinstate" && report.status !== "pending") {
    throw new Error("This report has already been reviewed")
  }

  const subject =
    kind === "user"
      ? { userId: (report as { reported_id: string }).reported_id, chatGroupId: null }
      : kind === "event"
        ? // An event report is about a listing, not a person. See the row mapping.
          { userId: null, chatGroupId: null }
        : await messageSubject(report as { message_id: string; message_type: string })
  const subjectId = subject.userId

  if ((decision === "suspend" || decision === "reinstate") && !subjectId) {
    throw new Error("The reported message no longer exists, so its author cannot be resolved")
  }

  if (decision === "remove_message") {
    const r = report as { message_id: string; message_type: string }
    if (kind !== "message" || r.message_type !== "group") {
      throw new Error("Only messages in a group room can be removed")
    }
  }

  if (decision === "delist" && kind !== "event") {
    throw new Error("Only an event can be delisted")
  }

  const reviewed = {
    status: OUTCOME[decision === "reinstate" ? "dismiss" : decision],
    reviewed_by: session.user.id,
    reviewed_at: new Date(),
  }

  await db.$transaction(async (tx) => {
    // A reinstate after the fact leaves the report's own verdict alone: the
    // report was upheld, the suspension is what is being lifted.
    if (decision !== "reinstate" || report.status === "pending") {
      if (kind === "user") {
        await tx.user_reports.update({ where: { id: reportId }, data: reviewed })
      } else if (kind === "event") {
        await tx.event_reports.update({ where: { id: reportId }, data: reviewed })
      } else {
        await tx.message_reports.update({ where: { id: reportId }, data: reviewed })
      }
    }

    /*
     * Delist, never cancel.
     *
     * `unlisted` removes it from the feed, from search and from city counts —
     * all three filter `visibility = 'public'` — and leaves check-ins, the
     * chatroom and RSVPs alone. Marking a real event `cancelled` on a third
     * party's say-so is worse than the listing was, and it is not reversible in
     * the way this is: an admin who delists wrongly can put it back.
     */
    if (decision === "delist") {
      await tx.events.update({
        where: { id: (report as { event_id: string }).event_id },
        data: { visibility: "unlisted" },
      })
    }

    if (decision === "remove_message") {
      await tx.chat_messages.update({
        where: { id: (report as { message_id: string }).message_id },
        data: { deleted_at: new Date(), deleted_by: session.user.id },
      })
    }

    /*
     * One implementation, in lib/suspension.ts, because this used to be four
     * statements written inline and one of them — `session.deleteMany()` — was
     * a no-op: the strategy is `jwt`, so there are no Session rows to delete.
     * The reviewer's UI said suspending "blocks the account everywhere and
     * signs it out", and it did neither.
     */
    if (decision === "suspend" && subjectId) {
      await applySuspension(tx, subjectId, session.user.id)
    }

    if (decision === "reinstate" && subjectId) {
      await liftSuspension(tx, subjectId)
    }
  })

  /*
   * Tell the room, as the flag queue's twin does. Driven from a phone: the
   * report landed, the admin pressed Remove, the row got `deleted_at`, and the
   * message stayed on the screen that had reported it until the next reload.
   */
  if (decision === "remove_message" && subject.chatGroupId && subjectId) {
    emitChatMessageHidden(subject.chatGroupId, (report as { message_id: string }).message_id, subjectId)
  }

  // Fire-and-forget by design (see lib/audit-log.ts): the decision is already
  // committed, so a failed audit write must not make the admin think their
  // action failed.
  auditLog({
    userId: session.user.id,
    action: `report.${decision}`,
    resource: kind === "user" ? "user_report" : kind === "event" ? "event_report" : "message_report",
    resourceId: reportId,
    details: { subjectId },
  })

  revalidatePath("/dashboard/moderation/reports")
  revalidatePath("/dashboard/moderation")
}

/**
 * Who wrote a reported message, across the two message tables — and, for a
 * room message, which room, because removing it has to be told to the room.
 */
async function messageSubject(report: {
  message_id: string
  message_type: string
}): Promise<{ userId: string | null; chatGroupId: string | null }> {
  if (report.message_type === "private") {
    const m = await db.private_messages.findUnique({
      where: { id: report.message_id },
      select: { sender_id: true },
    })
    return { userId: m?.sender_id ?? null, chatGroupId: null }
  }
  const m = await db.chat_messages.findUnique({
    where: { id: report.message_id },
    select: { user_id: true, chat_group_id: true },
  })
  return { userId: m?.user_id ?? null, chatGroupId: m?.chat_group_id ?? null }
}
