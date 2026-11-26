// Relative imports: reached from server.ts through lib/reminder-sweeper.ts (build:server is plain tsc).
import { db } from "./db"
import { freeWindowEndingEmail, sendEmail } from "./email"
import { liveEntitlement } from "./entitlements"
import { logger } from "./logger"
import { mayBuyHere } from "./plan-market"

/** How long before `analytics_free_until` the mail goes (DECISIONS 2026-11-25: "one email 14 days before it ends"). */
export const FREE_WINDOW_NOTICE_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

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
