"use server"

import { Refusal } from "./refusal"
import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { currentUser } from "@/lib/current-user"
import { auditInTx, auditLog } from "@/lib/audit-log"
import { dashboardSessionsEnded, endPhoneSessions, phoneSessionsEnded } from "@/lib/session-end"
import { userLimit, rateLimit } from "@/lib/rate-limit"
import { passwordStrength } from "@/lib/password-strength"

/**
 * The signed-in user acting on their own account.
 *
 * This exists because the approval email tells every new host to "change the
 * password after your first sign-in" and there was nowhere in the product to do
 * it. We generated a password, emailed it in plaintext, and gave them no way to
 * rotate it.
 */

async function requireUser() {
  // Through the one revocation rule, with the row's role (step 18, M6).
  const user = await currentUser()
  if (!user) throw new Refusal("Unauthorized")
  return user
}

export async function updateProfile(name: string): Promise<void> {
  const user = await requireUser()
  const trimmed = name.trim()
  if (trimmed.length < 2) throw new Refusal("Name is too short.")
  if (trimmed.length > 120) throw new Refusal("Name is too long.")

  await db.user.update({ where: { id: user.id }, data: { name: trimmed } })

  auditLog({ userId: user.id, action: "account.profile_updated", resource: "user", resourceId: user.id })
  revalidatePath("/dashboard/settings")
}

export interface PasswordResult {
  ok: boolean
  error?: string
  /** Phone sessions ended alongside the change — so the screen can say so. */
  revokedSessions?: number
}

/**
 * Change your own password.
 *
 * The current password is required even though the session already proves
 * identity: it is what stops a walked-away laptop becoming a permanent account
 * takeover, and it is the reason every product asks.
 *
 * Every session on the account ends with it: the phones (SCRUM-169, below)
 * and every dashboard session, this one included — `password_changed_at` is
 * what `isRevoked` (lib/session-revocation.ts) judges a session by (step 18
 * security review, M6). Someone changing a password because of a compromise
 * must not leave the other person signed in, and a JWT session cannot be
 * ended any other way.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<PasswordResult> {
  const user = await requireUser()

  // Guessing the current password is an online attack against a known account,
  // so it gets the same treatment as sign-in.
  const limited = await rateLimit(
    // The limiter reads headers for its default key; this policy keys on the
    // user, so an empty request object is enough.
    { headers: new Headers() } as never,
    userLimit("heavy", "account:password", user.id)
  )
  if (limited) return { ok: false, error: "Too many attempts. Wait a minute and try again." }

  const record = await db.user.findUnique({
    where: { id: user.id },
    select: { password: true, email: true, name: true },
  })
  if (!record?.password) {
    return { ok: false, error: "This account signs in with Google and has no password to change." }
  }

  if (!(await bcrypt.compare(currentPassword, record.password))) {
    // Deliberately not "that is not your password" — same wording whatever the
    // reason, and the rate limit above is what actually stops guessing.
    return { ok: false, error: "Current password is incorrect." }
  }

  const strength = passwordStrength(newPassword, { email: record.email, name: record.name ?? undefined })
  if (!strength.acceptable) {
    return { ok: false, error: strength.advice ?? "Pick a stronger password." }
  }

  if (await bcrypt.compare(newPassword, record.password)) {
    return { ok: false, error: "That is already your password." }
  }

  /*
   * The new hash and the end of every phone session, together (SCRUM-169).
   *
   * The reset-link path has always revoked the mobile refresh tokens, and says
   * why: somebody changing a password because they were compromised must not
   * leave the attacker's phone signed in for up to thirty days. This path is
   * the same person doing the same thing for the same reason, and until now
   * it kept every phone alive — five before, five after, read back on staging.
   * One transaction, so a hash cannot land without the revoke or vice versa.
   */
  const hash = await bcrypt.hash(newPassword, 12)
  const at = new Date()
  const ended = await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      // Every dashboard session signed in before now ends, this one included (M6).
      data: { password: hash, password_changed_at: at },
    })
    return endPhoneSessions(tx, user.id, "password_reset")
  })
  const revoked = ended.live
  // And what was live when it changed closes now (SCRUM-603).
  dashboardSessionsEnded(user.id)
  phoneSessionsEnded(user.id, ended.at)

  auditLog({
    userId: user.id,
    action: "account.password_changed",
    resource: "user",
    resourceId: user.id,
    details: { revokedSessions: revoked },
  })
  revalidatePath("/dashboard/settings")
  return { ok: true, revokedSessions: revoked }
}

/**
 * End every dashboard session on this account, this one included (SCRUM-603).
 *
 * A dashboard session is a JWT with nothing stored behind it, so this used to
 * delete NextAuth `Session` rows that the JWT strategy never writes: it ended
 * nothing and said "No other sessions to end". The stamp is what `isRevoked`
 * (lib/session-revocation.ts) judges every session by, as it does a password
 * change. This browser's session signed in before it too, so it ends as well
 * and the screen signs out; keeping it would mean re-minting a cookie that
 * never proved the password again.
 */
export async function endDashboardSessions(): Promise<void> {
  const user = await requireUser()
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { sessions_revoked_at: new Date() } })
    await auditInTx(tx, { userId: user.id, action: "account.sessions_revoked", resource: "user", resourceId: user.id })
  })
  // A socket already open keeps the live room coming until it is closed.
  dashboardSessionsEnded(user.id)
  revalidatePath("/dashboard/settings")
}

/**
 * Sign every phone out of this account: `endPhoneSessions` (lib/session-end.ts)
 * — refresh tokens, push tokens, and every access token issued until now —
 * and their live sockets closed.
 *
 * Separate from dashboard sessions because they are separate auth systems — the
 * mobile app holds 30-day refresh tokens that a dashboard sign-out does not
 * touch, and someone who has lost a phone needs exactly this.
 */
export async function revokeMobileSessions(): Promise<number> {
  const user = await requireUser()
  const ended = await db.$transaction(async (tx) => {
    const result = await endPhoneSessions(tx, user.id, "signout_all")
    await auditInTx(tx, {
      userId: user.id,
      action: "account.mobile_tokens_revoked",
      resource: "user",
      resourceId: user.id,
      details: { count: result.live },
    })
    return result
  })
  phoneSessionsEnded(user.id, ended.at)
  revalidatePath("/dashboard/settings")
  return ended.live
}

export async function getAccount() {
  const user = await requireUser()
  const record = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { name: true, email: true, image: true, role: true, password: true, createdAt: true },
  })
  const mobileSessions = await db.mobile_refresh_tokens.count({
    where: { user_id: user.id, revoked_at: null, expires_at: { gt: new Date() } },
  })
  return {
    name: record.name ?? "",
    email: record.email,
    image: record.image,
    role: record.role,
    /** Google-only accounts have no password to change. */
    hasPassword: !!record.password,
    createdAt: record.createdAt,
    mobileSessions,
  }
}
