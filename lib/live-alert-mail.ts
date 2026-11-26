// Relative imports: reached from server.ts through lib/event-issues.ts, and build:server emits `@/` verbatim.
import { db } from "./db"
import { dashboardUrl, liveAlertEmail } from "./email"
import { realEventsWhere } from "./event-kind"
import { eventClock } from "./event-phase"
import { logger } from "./logger"
import { mailOwnersAndAdmins } from "./results-mail"

/**
 * A room on the line (100 in, 99, 100 again) closes and reopens its issue every pass, each a new row; one mail per
 * event and kind while openings keep coming closer together than this.
 */
const LIVE_ALERT_QUIET_MS = 30 * 60_000

type OpenedIssue = { id: string; eventId: string; kind: string; title: string; body: string; openedAt: Date }

/**
 * Mail the organizer's owners and admins that a critical alert opened (SCRUM-1286, audit/dashboard-ia.md finding 11):
 * a host who is not on the dashboard is told nowhere else. Called without `await` from the issue sweep; never rejects,
 * and every failure is logged with the event and kind.
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
    if (!event?.organizer_org_id) return

    // ponytail: a chain of openings each under 30 minutes apart stays quiet after the first mail; the host was told and
    // the Live tab has the rest. A per-row "mailed" column would let it mail every 30 minutes instead.
    const recent = await db.event_issues.count({
      where: {
        event_id: issue.eventId,
        kind: issue.kind,
        id: { not: issue.id },
        opened_at: { gte: new Date(issue.openedAt.getTime() - LIVE_ALERT_QUIET_MS) },
      },
    })
    if (recent > 0) return

    const mail = liveAlertEmail({
      eventTitle: event.title,
      alertTitle: issue.title,
      body: issue.body,
      openedAt: eventClock(event.timezone).time(issue.openedAt),
      liveUrl: `${dashboardUrl()}/dashboard/events/${issue.eventId}?tab=live`,
    })
    const result = await mailOwnersAndAdmins(event.organizer_org_id, "live_alert", () => mail)
    logger[result.failed ? "warn" : "info"]("Live alert mail sent", { ...ids, ...result })
  } catch (error) {
    logger.error("Live alert mail failed", { ...ids, error: error instanceof Error ? error.message : String(error) })
  }
}
