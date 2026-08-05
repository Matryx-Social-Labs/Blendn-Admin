"use server"

import bcrypt from "bcryptjs"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import { auditLog } from "@/lib/audit-log"
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
  const session = await getAuth()
  if (!session?.user?.id) throw new Error("Unauthorized")
  return session.user
}

export async function updateProfile(name: string): Promise<void> {
  const user = await requireUser()
  const trimmed = name.trim()
  if (trimmed.length < 2) throw new Error("Name is too short.")
  if (trimmed.length > 120) throw new Error("Name is too long.")

  await db.user.update({ where: { id: user.id }, data: { name: trimmed } })

  auditLog({ userId: user.id, action: "account.profile_updated", resource: "user", resourceId: user.id })
  revalidatePath("/dashboard/settings")
}

export interface PasswordResult {
  ok: boolean
  error?: string
}

/**
 * Change your own password.
 *
 * The current password is required even though the session already proves
 * identity: it is what stops a walked-away laptop becoming a permanent account
 * takeover, and it is the reason every product asks.
 *
 * Other sessions are deliberately **left signed in**. Ending them is a separate,
 * explicit action — someone rotating a password as hygiene should not silently
 * lose their phone, and someone who suspects a compromise wants to end sessions
 * whether or not they are changing the password.
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

  await db.user.update({
    where: { id: user.id },
    data: { password: await bcrypt.hash(newPassword, 12) },
  })

  auditLog({ userId: user.id, action: "account.password_changed", resource: "user", resourceId: user.id })
  revalidatePath("/dashboard/settings")
  return { ok: true }
}

export interface SessionRow {
  id: string
  expires: Date
  current: boolean
}

/**
 * Active dashboard sessions.
 *
 * NextAuth's `Session` table is all there is — no device or location is
 * recorded, so the screen shows what exists (when it expires) rather than
 * inventing a "Chrome · macOS · Bengaluru" line from nothing.
 */
export async function listSessions(): Promise<SessionRow[]> {
  const user = await requireUser()
  const rows = await db.session.findMany({
    where: { userId: user.id, expires: { gt: new Date() } },
    orderBy: { expires: "desc" },
    select: { id: true, expires: true },
  })
  // The JWT strategy means the current session may not be a row at all, so
  // nothing is marked "this device" rather than marking the wrong one.
  return rows.map((r) => ({ ...r, current: false }))
}

export async function signOutEverywhereElse(): Promise<number> {
  const user = await requireUser()
  const { count } = await db.session.deleteMany({ where: { userId: user.id } })

  auditLog({
    userId: user.id,
    action: "account.sessions_revoked",
    resource: "user",
    resourceId: user.id,
    details: { count },
  })
  revalidatePath("/dashboard/settings")
  return count
}

/**
 * Revoke every mobile refresh token for this account.
 *
 * Separate from dashboard sessions because they are separate auth systems — the
 * mobile app holds 30-day refresh tokens that a dashboard sign-out does not
 * touch, and someone who has lost a phone needs exactly this.
 */
export async function revokeMobileSessions(): Promise<number> {
  const user = await requireUser()
  const { count } = await db.mobile_refresh_tokens.updateMany({
    where: { user_id: user.id, revoked_at: null },
    data: { revoked_at: new Date() },
  })

  auditLog({
    userId: user.id,
    action: "account.mobile_tokens_revoked",
    resource: "user",
    resourceId: user.id,
    details: { count },
  })
  revalidatePath("/dashboard/settings")
  return count
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
