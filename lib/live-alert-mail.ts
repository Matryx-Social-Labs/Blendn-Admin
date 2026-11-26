// Relative imports: reached from server.ts through lib/event-issues.ts, and build:server emits `@/` verbatim.
import { db } from "./db"
import { dashboardUrl, liveAlertEmail } from "./email"
import { realEventsWhere } from "./event-kind"
import { eventClock } from "./event-phase"
import type { LiveAlertKind } from "./live-metrics"
import { logger } from "./logger"
import { mailOwnersAndAdmins } from "./results-mail"

/**
 * A room on the line (100 in, 99, 100 again) closes and reopens its issue every pass, each a new row; a kind mails
 * again for an event only once this long has passed since its last mail (`event_issues.mailed_at`).
 */
const LIVE_ALERT_QUIET_MS = 30 * 60_000

export type OpenedIssue = { id: string; eventId: string; kind: LiveAlertKind; title: string; body: string; openedAt: Date }

/**
 * Mail the organizer's owners and admins that a critical alert opened (SCRUM-1286, audit/dashboard-ia.md finding 11):
 * a host who is not on the dashboard is told nowhere else. Called without `await` from the issue sweep; never rejects,
 * and every outcome but a sent mail is logged with the event and kind.
 *
 * Only a real event with an organization: a venue day, a deleted event, or one with no organization mails nobody.
 */
export async function mailLiveAlert(issue: OpenedIssue): Promise<void> {
  const ids = { eventId: issue.eventId, kind: issue.kind }
  try {
    const event = await db.events.findFirst({
      where: { id: issue.eventId, ...realEventsWhere, deleted_at: null },
      select: { title: true, timezone: true, organizer_org_id: true },
    })
    if (!event?.organizer_org_id) {
      logger.info("Live alert not mailed: no organization", ids)
      return
    }

    const recent = await db.event_issues.count({
      where: { event_id: issue.eventId, kind: issue.kind, mailed_at: { gt: new Date(issue.openedAt.getTime() - LIVE_ALERT_QUIET_MS) } },
    })
    if (recent > 0) {
      logger.info("Live alert not mailed: mailed in the last 30 minutes", ids)
      return
    }
    // ponytail: count, then claim, is not atomic. Two openings of one kind racing (two occurrences, two replicas) would
    // both mail, never neither; the open-issue unique index already stops two rows for one occurrence.
    await db.event_issues.updateMany({ where: { id: issue.id }, data: { mailed_at: issue.openedAt } })

    const mail = liveAlertEmail({
      eventTitle: event.title,
      alertTitle: issue.title,
      body: issue.body,
      openedAt: eventClock(event.timezone).time(issue.openedAt),
      liveUrl: `${dashboardUrl()}/dashboard/events/${issue.eventId}?tab=live`,
    })
    let result = { recipients: 0, sent: 0, failed: 0 }
    try {
      result = await mailOwnersAndAdmins(event.organizer_org_id, "live_alert", () => mail)
    } finally {
      // Nobody got it: give the claim back, so the next opening of this kind tries again.
      if (result.sent === 0) await db.event_issues.updateMany({ where: { id: issue.id, mailed_at: issue.openedAt }, data: { mailed_at: null } })
    }
    if (result.sent > 0) logger.info("Live alert mail sent", { ...ids, ...result })
    else logger.warn("Live alert mail reached nobody", { ...ids, ...result })
  } catch (error) {
    logger.error("Live alert mail failed", { ...ids, error: error instanceof Error ? error.message : String(error) })
  }
}
