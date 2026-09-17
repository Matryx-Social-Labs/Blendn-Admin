import { db } from "@/lib/db"
import { claimDecisionEmail, emailConfigured, sendEmail } from "@/lib/email"
import { logger } from "@/lib/logger"

/**
 * Telling a claimant what was decided.
 *
 * Every decide form said the reason "is sent to the claimant" and nothing sent
 * it (SCRUM-117): reviewers wrote a paragraph to nobody, and the one thing that
 * stops an identical re-file never left the row. Email is the channel — the
 * claimant is a dashboard user (or, for an event claim, an address with no
 * account yet), and the app's notification bell is not theirs.
 *
 * Unconfigured is a first-class state, as everywhere else: the decision has
 * already committed, and the caller shows the reviewer that nothing went out.
 */
export interface ClaimDecision {
  to: string
  name: string | null
  /** The thing claimed, already phrased: "the venue Church Street Social". */
  what: string
  outcome: "approved" | "declined"
  reason: string | null
  link: string | null
}

export async function notifyClaimant(d: ClaimDecision): Promise<boolean> {
  if (!emailConfigured()) {
    logger.info("Claim decision not emailed — email unconfigured", { to: d.to, what: d.what })
    return false
  }
  const result = await sendEmail({ to: d.to, ...claimDecisionEmail(d.name ?? "there", d.what, d.outcome, d.reason, d.link) })
  if (!result.sent) logger.error("Claim decision email failed", { to: d.to, what: d.what, reason: result.reason })
  return result.sent
}

/** Who filed it, for the claims that carry a user id rather than an address. */
export async function claimants(userIds: string[]): Promise<Map<string, { email: string; name: string | null }>> {
  const rows = await db.user.findMany({
    where: { id: { in: [...new Set(userIds)] } },
    select: { id: true, email: true, name: true },
  })
  return new Map(rows.map((r) => [r.id, { email: r.email, name: r.name }]))
}
