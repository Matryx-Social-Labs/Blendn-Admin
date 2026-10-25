import type { Prisma } from "@prisma/client"
import { auditLog } from "./audit-log"
import { db } from "./db"
import { reviewAccountEmails } from "./env"
import { logger } from "./logger"

/**
 * App Review accounts (DEPLOYMENT.md § 7). OFF unless `REVIEW_ACCOUNT_EMAILS`
 * names somebody; the owner decides whether to set it. For those accounts only:
 *
 * - `geofence`: check-in (and the presence ping that keeps them in) at an
 *   event marked `review_demo` skips the geofence, so a reviewer in Cupertino
 *   can reach the Room of an event in Bengaluru;
 * - `plus_gating`: Blendn+ is treated as gated (`PLUS_GATING` on), so the
 *   plans show and a purchase visibly unlocks something;
 * - `sandbox_purchase`: a RevenueCat SANDBOX purchase is credited in
 *   production, as Apple expects of a server App Review buys from.
 *
 * Every bypass is logged and audited (`review.bypass`). With the list empty no
 * query runs and nothing changes for anybody.
 */

export type ReviewBypass = "geofence" | "plus_gating" | "sandbox_purchase"

type Reader = Pick<Prisma.TransactionClient, "user">

/** Is this a listed review account (and not deleted)? False, with no query, while the list is empty. */
export async function isReviewAccount(userId: string | null | undefined, client: Reader = db): Promise<boolean> {
  const emails = reviewAccountEmails()
  if (emails.size === 0 || !userId) return false
  const user = await client.user.findUnique({ where: { id: userId }, select: { email: true, deletedAt: true } })
  return !!user?.email && !user.deletedAt && emails.has(user.email.toLowerCase())
}

/** One audit row per account, bypass and resource per window; a log line every time. */
const AUDIT_WINDOW_MS = 10 * 60_000
const lastAudited = new Map<string, number>()

/**
 * Record a bypass. Logged every time; audited at most once per account,
 * bypass and resource every ten minutes, because the presence ping and the
 * Plus gate ask every few minutes for as long as a review runs.
 * ponytail: per-process Map; a second replica audits its own first one too.
 */
export function recordReviewBypass(userId: string, bypass: ReviewBypass, details: Record<string, string> = {}): void {
  logger.info("App Review account: bypass applied", { userId, bypass, ...details })
  const key = `${userId}|${bypass}|${details.eventId ?? details.ref ?? ""}`
  const now = Date.now()
  if ((lastAudited.get(key) ?? 0) > now - AUDIT_WINDOW_MS) return
  lastAudited.set(key, now)
  auditLog({ userId, action: "review.bypass", resource: "user", resourceId: userId, details: { bypass, ...details } })
}

/** Forget the audit window (tests). */
export function resetReviewBypassAudit(): void {
  lastAudited.clear()
}
