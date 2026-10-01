"use server"

import { Refusal } from "@/lib/refusal"
import { revalidatePath } from "next/cache"
import type { report_status } from "@prisma/client"

import { auditLog } from "@/lib/audit-log"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { emitChatMessageHidden, evictUserSockets } from "@/lib/socket-server"
import { blockAccountNow } from "@/lib/account-blocklist"
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
  /** Message reports only — a board post's body and a board ask's message included. */
  excerpt: string | null
  messageType: "group" | "private" | "board_post" | "board_request" | null
  /** Board posts only: offer, seeking or chat — what was being arranged. */
  boardKind: string | null
  /** Taken down already: a removed room message, or a withdrawn or removed board post. */
  messageDeleted: boolean
  /** The reported post or ask itself is gone — erased with its author's account. */
  gone: boolean
  /** A board post a moderator has not yet removed (withdrawn-but-unmarked included). */
  removable: boolean
  /**
   * Reports in this tab about the same thing, this one included. One account
   * files one board report (a partial unique); this is how many people did.
   */
  sameSubject: number
  eventTitle: string | null
  eventId: string | null
  /**
   * Event reports only: true when it is about the event's room, not the event
   * (`POST /chat/groups/:id/report`). Delisting is not offered on these — a
   * hostile room is not a misleading listing.
   */
  room: boolean
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
  if (session?.user?.role !== "app_admin") throw new Refusal("Not authorised")

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
        excerpt: true,
        reviewed_by: true,
        reporter_id: true,
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
        chat_group_id: true,
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
  const idsOf = (type: string) =>
    messageReports.filter((r) => r.message_type === type).map((r) => r.message_id)
  const [groupIds, privateIds, boardPostIds, boardRequestIds] = [
    idsOf("group"),
    idsOf("private"),
    idsOf("board_post"),
    idsOf("board_request"),
  ]

  const person = { select: { id: true, name: true, email: true, suspended_at: true } } as const
  const [groupMessages, privateMessages, boardPosts, boardRequests] = await Promise.all([
    groupIds.length
      ? db.chat_messages.findMany({
          where: { id: { in: groupIds } },
          select: {
            id: true,
            content: true,
            deleted_at: true,
            user: person,
            chat_group: { select: { event_id: true, event: { select: { title: true } } } },
          },
        })
      : [],
    privateIds.length
      ? db.private_messages.findMany({
          where: { id: { in: privateIds } },
          select: { id: true, message_text: true, sender: person },
        })
      : [],
    /*
     * The board (SCRUM-322). Reported from the app by post or by ask, because
     * the board never gives the client a user id; the person is resolved here,
     * where real names are the point.
     */
    boardPostIds.length
      ? db.board_posts.findMany({
          where: { id: { in: boardPostIds } },
          select: {
            id: true,
            kind: true,
            body: true,
            deleted_at: true,
            moderation_status: true,
            event_id: true,
            event: { select: { title: true } },
            author: person,
          },
        })
      : [],
    boardRequestIds.length
      ? db.board_requests.findMany({
          where: { id: { in: boardRequestIds } },
          select: {
            id: true,
            message: true,
            event_id: true,
            event: { select: { title: true } },
            from: person,
            to: person,
          },
        })
      : [],
  ])

  const groupById = new Map(groupMessages.map((m) => [m.id, m]))
  const privateById = new Map(privateMessages.map((m) => [m.id, m]))
  const boardPostById = new Map(boardPosts.map((p) => [p.id, p]))
  const boardRequestById = new Map(boardRequests.map((r) => [r.id, r]))

  /*
   * How many reports in this tab name the same thing. Grouped by subject so a
   * pile-on reads as one subject reported by many people, and a flood from one
   * account (which the board's partial unique now stops) would read as one.
   */
  const [userSubjects, messageSubjects, eventSubjects] = await Promise.all([
    db.user_reports.groupBy({
      by: ["reported_id"],
      where: { status, reported_id: { in: userReports.map((r) => r.reported.id) } },
      _count: { _all: true },
    }),
    db.message_reports.groupBy({
      by: ["message_id"],
      where: { status, message_id: { in: messageReports.map((r) => r.message_id) } },
      _count: { _all: true },
    }),
    db.event_reports.groupBy({
      by: ["event_id"],
      where: { status, event_id: { in: eventReports.map((r) => r.event_id) } },
      _count: { _all: true },
    }),
  ])
  const sameUser = new Map(userSubjects.map((g) => [g.reported_id, g._count._all]))
  const sameMessage = new Map(messageSubjects.map((g) => [g.message_id, g._count._all]))
  const sameEvent = new Map(eventSubjects.map((g) => [g.event_id, g._count._all]))

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
        boardKind: null,
        messageDeleted: false,
        gone: false,
        removable: false,
        sameSubject: sameUser.get(r.reported.id) ?? 1,
        eventTitle: null,
        eventId: null,
        room: false,
        reviewedBy: r.reviewed_by,
      })
    ),
    ...messageReports.map((r): ReportRow => {
      const base = {
        id: r.id,
        kind: "message" as const,
        ageHours: ageHours(r.created_at, now),
        reason: r.reason,
        description: r.description,
        reporterName: displayName(r.reporter),
        room: false,
        reviewedBy: r.reviewed_by,
        sameSubject: sameMessage.get(r.message_id) ?? 1,
      }
      if (r.message_type === "board_post") {
        const post = boardPostById.get(r.message_id)
        return {
          ...base,
          subjectId: post?.author.id ?? null,
          subjectName: displayName(post?.author ?? null),
          subjectSuspended: post?.author.suspended_at != null,
          // What was reported, as it was then; the live body if it predates
          // the snapshot.
          excerpt: (r.excerpt ?? post?.body ?? "").slice(0, 200) || null,
          messageType: "board_post",
          boardKind: post?.kind ?? null,
          messageDeleted: post?.deleted_at != null,
          gone: !post,
          removable: !!post && post.moderation_status !== "removed",
          eventTitle: post?.event.title ?? null,
          eventId: post?.event_id ?? null,
        }
      }
      if (r.message_type === "board_request") {
        const ask = boardRequestById.get(r.message_id)
        // About whichever of the two did not file it.
        const about = ask ? (ask.from.id === r.reporter_id ? ask.to : ask.from) : null
        return {
          ...base,
          subjectId: about?.id ?? null,
          subjectName: displayName(about),
          subjectSuspended: about?.suspended_at != null,
          excerpt: (r.excerpt ?? ask?.message ?? "").slice(0, 200) || null,
          messageType: "board_request",
          boardKind: null,
          messageDeleted: false,
          gone: !ask,
          removable: false,
          eventTitle: ask?.event.title ?? null,
          eventId: ask?.event_id ?? null,
        }
      }
      const group = groupById.get(r.message_id)
      const priv = privateById.get(r.message_id)
      const author = group?.user ?? priv?.sender ?? null
      return {
        ...base,
        subjectId: author?.id ?? null,
        subjectName: displayName(author),
        subjectSuspended: author?.suspended_at != null,
        // A message deleted between the report and the review leaves the row
        // saying so rather than showing an empty quote.
        excerpt: (group?.content ?? priv?.message_text ?? "").slice(0, 200) || null,
        messageType: r.message_type === "private" ? "private" : "group",
        boardKind: null,
        messageDeleted: group?.deleted_at != null,
        gone: !group && !priv,
        removable: false,
        eventTitle: group?.chat_group?.event?.title ?? null,
        eventId: group?.chat_group?.event_id ?? null,
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
        subjectName: r.chat_group_id
          ? `Room · ${r.event?.title ?? "Deleted event"}`
          : (r.event?.title ?? "Deleted event"),
        subjectSuspended: false,
        excerpt: null,
        messageType: null,
        boardKind: null,
        messageDeleted: false,
        gone: false,
        removable: false,
        sameSubject: sameEvent.get(r.event_id) ?? 1,
        eventTitle: r.event?.title ?? null,
        eventId: r.event_id,
        room: r.chat_group_id !== null,
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
    throw new Refusal("Only platform admins can resolve reports")
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
            select: { id: true, status: true, event_id: true, chat_group_id: true },
          })
        : await db.message_reports.findUnique({
            where: { id: reportId },
            select: { id: true, status: true, message_id: true, message_type: true, reporter_id: true },
          })

  if (!report) throw new Refusal("Report not found")
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
    throw new Refusal("This report has already been reviewed")
  }

  const subject =
    kind === "user"
      ? { userId: (report as { reported_id: string }).reported_id, chatGroupId: null }
      : kind === "event"
        ? // An event report is about a listing, not a person. See the row mapping.
          { userId: null, chatGroupId: null }
        : await messageSubject(
            report as { message_id: string; message_type: string; reporter_id: string }
          )
  const subjectId = subject.userId

  if ((decision === "suspend" || decision === "reinstate") && !subjectId) {
    throw new Refusal("The reported message no longer exists, so its author cannot be resolved")
  }

  if (decision === "remove_message") {
    const r = report as { message_id: string; message_type: string }
    if (kind !== "message" || (r.message_type !== "group" && r.message_type !== "board_post")) {
      throw new Refusal("Only a room message or a board post can be removed")
    }
    // Erased with its author's account: there is nothing to take down, and
    // "removed" would be a record of an action that did not happen.
    if (subject.boardPost && !subjectId) throw new Refusal("That post no longer exists")
  }

  if (decision === "delist" && kind !== "event") {
    throw new Refusal("Only an event can be delisted")
  }
  // A report about the room is not a report about the listing.
  if (decision === "delist" && (report as { chat_group_id: string | null }).chat_group_id) {
    throw new Refusal("This report is about the event's room, not its listing")
  }

  const reviewed = {
    status: OUTCOME[decision === "reinstate" ? "dismiss" : decision],
    reviewed_by: session.user.id,
    reviewed_at: new Date(),
  }

  // Whether a removal took anything down — false when the post was already
  // removed (a second report on it, or a second click), so the audit row says so.
  let removed: boolean | null = null

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

    if (decision === "remove_message" && subject.boardPost) {
      /*
       * Off the board, soft (SCRUM-322): `deleted_at`, which every board read
       * filters and which lapses the asks filed against it, and
       * `moderation_status = "removed"` so it reads as a moderator's removal
       * rather than its author's withdrawal. A post its author already
       * withdrew keeps its own timestamp.
       */
      const postId = (report as { message_id: string }).message_id
      const now = new Date()
      /*
       * Marked `removed` whether or not it is already down. A reported author
       * who withdrew the post first left it with a timestamp and no mark, and
       * a removal that skipped it would leave the record saying "withdrawn".
       * `not` on a nullable column excludes NULL, hence the explicit OR.
       */
      const marked = await tx.board_posts.updateMany({
        where: { id: postId, OR: [{ moderation_status: null }, { moderation_status: { not: "removed" } }] },
        data: { moderation_status: "removed", updated_at: now },
      })
      await tx.board_posts.updateMany({ where: { id: postId, deleted_at: null }, data: { deleted_at: now } })
      removed = marked.count > 0
    } else if (decision === "remove_message") {
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
    /*
     * A dismissed report releases the post it held — once no other report on
     * it is waiting. Filing stamped it `reported` so account erasure would keep
     * the evidence; with nothing left to decide, it is an ordinary post again.
     */
    if (decision === "dismiss" && subject.boardPost) {
      const postId = (report as { message_id: string }).message_id
      const waiting = await tx.message_reports.count({
        where: { message_type: "board_post", message_id: postId, status: "pending" },
      })
      if (waiting === 0) {
        await tx.board_posts.updateMany({
          where: { id: postId, moderation_status: "reported" },
          data: { moderation_status: null },
        })
      }
    }

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

  // After the commit, never inside it: see SUSPENSION_WRITE_CHANNELS.
  if (decision === "suspend" && subjectId) {
    evictUserSockets(subjectId)
    // Their access token stops working now, not one lifetime from now.
    blockAccountNow(subjectId)
  }

  // Fire-and-forget by design (see lib/audit-log.ts): the decision is already
  // committed, so a failed audit write must not make the admin think their
  // action failed.
  auditLog({
    userId: session.user.id,
    action: `report.${decision}`,
    resource: kind === "user" ? "user_report" : kind === "event" ? "event_report" : "message_report",
    resourceId: reportId,
    details: {
      subjectId,
      // Which board post came down, so the audit row names it without a join.
      ...(subject.boardPost && { boardPostId: (report as { message_id: string }).message_id }),
      ...(removed !== null && { removed }),
    },
  })

  revalidatePath("/dashboard/moderation/reports")
  revalidatePath("/dashboard/moderation")
}

/**
 * Who wrote a reported message, across the message tables — and, for a room
 * message, which room, because removing it has to be told to the room. A
 * board ask is about whichever of its two people did not report it.
 */
async function messageSubject(report: {
  message_id: string
  message_type: string
  reporter_id: string
}): Promise<{ userId: string | null; chatGroupId: string | null; boardPost?: true }> {
  if (report.message_type === "board_post") {
    const p = await db.board_posts.findUnique({
      where: { id: report.message_id },
      select: { author_id: true },
    })
    return { userId: p?.author_id ?? null, chatGroupId: null, boardPost: true }
  }
  if (report.message_type === "board_request") {
    const r = await db.board_requests.findUnique({
      where: { id: report.message_id },
      select: { from_user_id: true, to_user_id: true },
    })
    const userId = r ? (r.from_user_id === report.reporter_id ? r.to_user_id : r.from_user_id) : null
    return { userId, chatGroupId: null }
  }
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
