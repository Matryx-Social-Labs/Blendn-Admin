// Relative imports: reached from server.ts through lib/reminder-sweeper.ts, and build:server emits `@/` verbatim.
import { db } from "./db"
import { discloseHeadcount } from "./disclosure"
import { dashboardUrl, nextNightEmail } from "./email"
import { realEventsWhere } from "./event-kind"
import { nextLocalTime } from "./event-wall-clock"
import { logger } from "./logger"
import { HELD, mailOwnersAndAdmins, nightHeadcount } from "./results-mail"
import { RATING_REQUEST_HOUR } from "./services/event-notifications.service"

/**
 * The "list your next" nudge (SCRUM-1284, launch gate 14): one mail to an organization's owners and admins at the first
 * 10:00 on the night's clock a full week after its latest night, when nothing is coming up, at most once in 30 days.
 * Never more than a day late, so the first pass after a deploy mails nobody whose night was weeks ago.
 */
const DAY_MS = 86_400_000
const AFTER_MS = 7 * DAY_MS
const LATE_MS = DAY_MS
const EVERY_MS = 30 * DAY_MS

/** Rides the reminder loop's pass. Never throws: it runs on a timer in the server process. Returns mails sent. */
export async function sendNextNightNudges(now: Date = new Date()): Promise<number> {
  let sent = 0
  try {
    // Due is the first 10:00 after end + 7 days, so within a day of it; due in (now - 1 day, now] puts the end here.
    // ponytail: unbounded, but only held org nights in a two-day window; batch it if that ever runs to thousands.
    const nights = await db.events.findMany({
      where: {
        ...realEventsWhere,
        organizer_org_id: { not: null },
        ...HELD,
        end_time: { gt: new Date(now.getTime() - AFTER_MS - 2 * DAY_MS), lte: new Date(now.getTime() - AFTER_MS) },
      },
      select: { id: true, title: true, end_time: true, timezone: true, organizer_org_id: true, organizer_org: { select: { next_event_nudged_at: true } } },
      orderBy: [{ end_time: "desc" }, { id: "desc" }],
    })
    const seen = new Set<string>()
    for (const night of nights) {
      const orgId = night.organizer_org_id
      if (!orgId || seen.has(orgId)) continue
      seen.add(orgId)
      const due = nextLocalTime(new Date(night.end_time.getTime() + AFTER_MS), night.timezone, RATING_REQUEST_HOUR)
      if (due > now || now.getTime() - due.getTime() >= LATE_MS) continue
      if (!(await isLatestWithNothingNext(orgId, night.id, now))) continue
      const checkedIn = discloseHeadcount(await nightHeadcount(night.id))
      sent += await nudge(orgId, night.organizer_org?.next_event_nudged_at ?? null, now, (unsubscribeUrl) =>
        nextNightEmail({ title: night.title, checkedIn, nextUrl: `${dashboardUrl()}/dashboard/events/new`, unsubscribeUrl })
      )
    }
  } catch (error) {
    logger.error("Next-night nudge sweep failed", { error: error instanceof Error ? error.message : String(error) })
  }
  return sent
}

/** The org's latest ended held night is this one, and it has no published night that is still to come or on now. */
async function isLatestWithNothingNext(orgId: string, nightId: string, now: Date): Promise<boolean> {
  const [latest, comingUp] = await Promise.all([
    db.events.findFirst({
      where: { ...realEventsWhere, organizer_org_id: orgId, ...HELD, end_time: { lte: now } },
      orderBy: [{ end_time: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
    // Not yet over rather than not yet started: a night running right now is not "nothing coming up". A draft or a
    // cancelled night is not listed, so it does not count.
    db.events.count({ where: { ...realEventsWhere, organizer_org_id: orgId, status: "published", deleted_at: null, end_time: { gt: now } } }),
  ])
  return latest?.id === nightId && comingUp === 0
}

/**
 * Claim the organization's nudge, then mail it. The seam for 09a (first-event nudge): its own candidates and its own
 * mail, the same claim and the same 30 days. The claim is a conditional update before the send, so a second pass or a
 * second replica sends nothing; a send that reached nobody because the provider failed is given back to `prior`.
 */
async function nudge(
  orgId: string,
  prior: Date | null,
  now: Date,
  build: (unsubscribeUrl: string) => { subject: string; text: string; html: string }
): Promise<number> {
  const { count } = await db.organisations.updateMany({
    where: {
      id: orgId,
      status: { not: "suspended" },
      OR: [{ next_event_nudged_at: null }, { next_event_nudged_at: { lte: new Date(now.getTime() - EVERY_MS) } }],
    },
    data: { next_event_nudged_at: now },
  })
  if (count === 0) return 0
  const result = await mailOwnersAndAdmins(orgId, "next_night", build).catch((error: unknown) => {
      logger.error("Next-night nudge failed", { orgId, error: error instanceof Error ? error.message : String(error) })
      return { recipients: 0, sent: 0, failed: 1 }
    })
  if (result.sent === 0 && result.failed > 0) {
    await db.organisations.updateMany({ where: { id: orgId, next_event_nudged_at: now }, data: { next_event_nudged_at: prior } })
  }
  logger[result.failed ? "warn" : "info"]("Next-night nudge sent", { orgId, ...result })
  return result.sent
}
