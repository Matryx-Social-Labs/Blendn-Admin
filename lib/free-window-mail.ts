// Relative imports: reached from server.ts through lib/reminder-sweeper.ts (build:server is plain tsc).
import { FREE_WINDOW_DAYS, freeWindow } from "./analytics-access"
import { db } from "./db"
import { emailConfigured, freeWindowEndingEmail, sendEmail } from "./email"
import { liveEntitlement } from "./entitlements"
import { realEventsWhere } from "./event-kind"
import { logger } from "./logger"
import { mayBuyHere } from "./plan-market"

/** How long before `analytics_free_until` the mail goes (DECISIONS 2026-11-25: "one email 14 days before it ends"). */
const FREE_WINDOW_NOTICE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000
/** Windows the pass writes at most, for hosts who never opened Plan or Analytics (SCRUM-1421). */
const WINDOW_WRITES_PER_PASS = 25
/** Where the last pass's pick stopped, so a band of more than 25 takes turns (per process; a restart starts over). */
let windowPickOffset = 0
let warnedUnconfigured = false

/**
 * One mail per organisation per free window (SCRUM-1275), to its owners and
 * admins, 14 days before its free Analytics ends. Not to an organisation that
 * has Analytics now (paid or granted) or cannot buy where it runs events
 * (`mayBuyHere`); those are asked again next pass, so a grant that lapses
 * before the window ends still gets its warning.
 *
 * Claimed before it is sent, as the rating request is: a second pass or a
 * second replica finds the column set and sends nothing. A send that fails
 * after the claim is lost for that window, logged at warn with the org id, and
 * never retried: mailing twice is worse.
 *
 * Returns how many organisations it mailed.
 */
export async function sendFreeWindowEndingMail(now: Date = new Date()): Promise<number> {
  // Before anything is claimed (SCRUM-1421): an unset key would claim every organisation due and mail none of them.
  if (!emailConfigured()) {
    if (!warnedUnconfigured) logger.warn("Free-window ending mail off: RESEND_API_KEY or EMAIL_FROM unset")
    warnedUnconfigured = true
    return 0
  }
  // Its own catch: a failed window write never holds back the mail to organisations that have theirs.
  await writeMissingWindows(now).catch((error: unknown) =>
    logger.warn("Free windows not written this pass", { error: error instanceof Error ? error.message : String(error) })
  )

  // ponytail: unbounded, but only organisations whose window ends in the next 14 days and that are unmailed; the
  // entitled and the not-in-market among them are re-read every pass. Add a batch if that ever runs to thousands.
  const due = await db.organisations.findMany({
    where: {
      analytics_free_until: { gt: now, lte: new Date(now.getTime() + FREE_WINDOW_NOTICE_DAYS * DAY_MS) },
      analytics_free_ending_mailed_at: null,
      status: { not: "suspended" },
    },
    select: { id: true, display_name: true, analytics_free_until: true },
    orderBy: { analytics_free_until: "asc" },
  })

  let mailed = 0
  for (const org of due) {
    // One organisation's failure never holds back the rest of the batch, and always names the organisation.
    let claimed = false
    try {
      if (!org.analytics_free_until) continue
      if (await liveEntitlement({ kind: "org", id: org.id }, "analytics", now)) continue
      if (!(await mayBuyHere(org.id))) continue
      const { count } = await db.organisations.updateMany({
        where: { id: org.id, analytics_free_ending_mailed_at: null, status: { not: "suspended" } },
        data: { analytics_free_ending_mailed_at: now },
      })
      if (count === 0) continue
      claimed = true
      const mail = freeWindowEndingEmail({ orgName: org.display_name, endsAt: org.analytics_free_until })
      if (await mailOwnersAndAdmins(org.id, mail)) mailed++
    } catch (error) {
      // Claimed: lost for this window (never unclaimed: mailing twice is worse). Not claimed: asked again next pass.
      logger.warn(claimed ? "Free-window ending mail lost for this window" : "Free-window ending mail skipped this pass", {
        orgId: org.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return mailed
}

/** Whether anybody was sent it. Every recipient it could not reach is logged at warn with the org id. */
async function mailOwnersAndAdmins(orgId: string, mail: { subject: string; text: string; html: string }): Promise<boolean> {
  const members = await db.organisation_members.findMany({
    where: { org_id: orgId, role: { in: ["owner", "admin"] }, user: { deletedAt: null } },
    select: { user: { select: { email: true } } },
  })
  const results = await Promise.all(members.map((m) => sendEmail({ to: m.user.email, ...mail })))
  const unsent = results.filter((r) => !r.sent)
  if (members.length === 0 || unsent.length > 0) {
    logger.warn("Free-window ending mail lost for this window", {
      orgId,
      recipients: members.length,
      unsent: unsent.length,
      reasons: [...new Set(unsent.map((r) => r.detail ?? r.reason))],
    })
  }
  return unsent.length < members.length
}

/**
 * The window is otherwise written only when somebody opens Plan or Analytics
 * (`analyticsAccess`), so a host who never did would never be picked above
 * (SCRUM-1421). Written here through the same `freeWindow`, for organisations
 * with a real night that ended 76 to 90 days ago: the nights whose window
 * could end within the notice. An older first night gives a window already
 * past, written and not mailed; a newer one is written when it reaches day 76.
 * Nothing is read for an organisation that has its window.
 *
 * ponytail: 25 a pass, oldest organisation first, the next 25 on the next
 * pass. A night under 8 is recounted each turn while it is in the 14-day band
 * (about 3 indexed queries per organisation); remember who was counted if
 * that grows. The pick reads the whole (status, end_time) index on events;
 * a partial index on end_time once events pass ~500k rows. A sweeper down for
 * over 14 days lets a night leave the band unmailed (written on first view).
 */
async function writeMissingWindows(now: Date): Promise<void> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS)
  const orgs = await db.organisations.findMany({
    where: {
      analytics_free_until: null,
      events: {
        some: {
          ...realEventsWhere,
          deleted_at: null,
          end_time: { gt: daysAgo(FREE_WINDOW_DAYS), lte: daysAgo(FREE_WINDOW_DAYS - FREE_WINDOW_NOTICE_DAYS) },
        },
      },
    },
    select: { id: true },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    skip: windowPickOffset,
    take: WINDOW_WRITES_PER_PASS,
  })
  windowPickOffset = orgs.length < WINDOW_WRITES_PER_PASS ? 0 : windowPickOffset + orgs.length
  for (const org of orgs) {
    try {
      await freeWindow(org.id, now)
    } catch (error) {
      // Asked again next pass; one organisation never holds back the rest, or the mail.
      logger.warn("Free window not written this pass", {
        orgId: org.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
