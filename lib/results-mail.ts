// Relative imports: reached from server.ts through lib/reminder-sweeper.ts, and build:server emits `@/` verbatim.
import { distinctAttendees } from "./counting"
import { db } from "./db"
import { discloseHeadcount, discloseStars, spreadsByEventId } from "./disclosure"
import { canonicalEmail, dashboardUrl, noCheckInsEmail, resultsEmail, sendEmail } from "./email"
import { emailReplyTo } from "./env"
import { realEventsWhere } from "./event-kind"
import { nextLocalTime } from "./event-wall-clock"
import { logger } from "./logger"
import { publishedRatingGroups } from "./rating-batches"
import { RATING_REQUEST_ENDED_WITHIN_MS, RATING_REQUEST_HOUR } from "./services/event-notifications.service"
import { unsubscribeUrl } from "./unsubscribe"

/**
 * The host's results mail (SCRUM-1282, launch gate 14): once per org event, to the organization's owners and admins,
 * at 10:00 on the event's clock the morning after it ends — the same morning and the same lookback as the rating
 * request, so the first pass after a deploy mails only the nights that ended in the last 34 h, never the archive.
 */
export const RESULTS_MAIL_ENDED_WITHIN_MS = RATING_REQUEST_ENDED_WITHIN_MS
const BATCH = 50

type MailedEvent = { id: string; title: string; end_time: Date; timezone: string; organizer_org_id: string | null }

/**
 * Rides the reminder loop's pass. Never throws: it runs on a timer in the server process. Returns mails sent.
 *
 * Once per event across passes and replicas: a conditional update on `results_mailed_at` before the send, like
 * `rating_requested_at`.
 */
export async function sendResultsMails(now: Date = new Date()): Promise<number> {
  let sent = 0
  try {
    const events: MailedEvent[] = await db.events.findMany({
      where: {
        ...realEventsWhere,
        organizer_org_id: { not: null },
        status: { in: ["published", "completed"] },
        deleted_at: null,
        results_mailed_at: null,
        end_time: { lte: now, gt: new Date(now.getTime() - RESULTS_MAIL_ENDED_WITHIN_MS) },
      },
      select: { id: true, title: true, end_time: true, timezone: true, organizer_org_id: true },
      orderBy: { end_time: "asc" },
      take: BATCH,
    })
    for (const event of events) {
      if (nextLocalTime(event.end_time, event.timezone, RATING_REQUEST_HOUR) > now) continue
      const { count: claimed } = await db.events.updateMany({
        where: { id: event.id, results_mailed_at: null },
        data: { results_mailed_at: now },
      })
      if (claimed === 0) continue
      // ponytail: claimed before the send, so a crash between the two loses this night's mail rather than sending it
      // twice; an outbox would recover it, add one if a lost morning mail is ever seen.
      sent += await mailResults(event).catch((error) => {
        logger.error("Results mail failed", { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
        return 0
      })
    }
  } catch (error) {
    logger.error("Results mail sweep failed", { error: error instanceof Error ? error.message : String(error) })
  }
  return sent
}

async function mailResults(event: MailedEvent): Promise<number> {
  const orgId = event.organizer_org_id!
  const [members, checkIns, ratingGroups, moodMessages] = await Promise.all([
    // Organization membership, never `events.organizer_id`: a member who left gets nothing (CLAUDE.md RBAC).
    db.organisation_members.findMany({
      where: { org_id: orgId, role: { in: ["owner", "admin"] }, user: { deletedAt: null, suspended_at: null } },
      select: { user: { select: { id: true, email: true } } },
    }),
    // The Overview's "Checked in" for an ended event: people, not rows, staff left out (`distinctAttendees`).
    db.event_check_ins.findMany({ where: { event_id: event.id, check_in_time: { not: null } }, select: { user_id: true, kind: true } }),
    publishedRatingGroups({ id: event.id }),
    // The Overview's mood panel's "classified msgs" for a host: every row.
    db.event_feedback.count({ where: { event_id: event.id } }),
  ])

  const attended = distinctAttendees(checkIns)
  // The org's first mailed night only (Fable advisor, 2026-11-26); this event is already claimed, so it is excluded.
  if (attended === 0 && (await db.events.count({ where: { organizer_org_id: orgId, id: { not: event.id }, results_mailed_at: { not: null } } })) > 0) return 0

  const stars = discloseStars(spreadsByEventId(ratingGroups).get(event.id) ?? [0, 0, 0, 0, 0])
  const base = dashboardUrl()
  const nextUrl = `${base}/dashboard/events/new`
  const replyTo = emailReplyTo()

  let sent = 0
  for (const { user } of members) {
    const unsubscribe = unsubscribeUrl(user)
    const mail =
      attended === 0
        ? noCheckInsEmail({ title: event.title, nextUrl, unsubscribeUrl: unsubscribe })
        : resultsEmail({
            title: event.title,
            checkedIn: discloseHeadcount(attended),
            averageRating: stars.averageRating,
            ratingCount: stars.ratingCount,
            moodMessages,
            overviewUrl: `${base}/dashboard/events/${event.id}`,
            nextUrl,
            unsubscribeUrl: unsubscribe,
          })
    // sendEmail never throws, checks the suppression list (an unsubscribe stops `lifecycle`), and logs its own failure.
    const result = await sendEmail({
      to: canonicalEmail(user.email),
      ...mail,
      stream: "lifecycle",
      tags: [{ name: "kind", value: "results" }],
      headers: {
        "List-Unsubscribe": `<${unsubscribe}>${replyTo ? `, <mailto:${replyTo}?subject=unsubscribe>` : ""}`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    })
    if (result.sent) sent++
  }
  logger.info("Results mail sent", { eventId: event.id, recipients: members.length, sent })
  return sent
}
