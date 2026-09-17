import { db } from "@/lib/db"
import { appUrl } from "@/lib/email"
import { hashInviteToken, newInviteToken } from "@/lib/org-invites"

/**
 * One single-use, hashed, expiring token per person; issuing a new one spends
 * the old. Used by forgot-password and by approval, which hands a new host a
 * link to set their first password rather than the password itself
 * (SCRUM-134): an email is forwarded, quoted and indexed, and a link that
 * expires and can be used once is a much smaller thing to lose than a
 * credential that works until someone remembers to change it.
 */
export async function issuePasswordResetLink(userId: string, ttlMs: number): Promise<string> {
  await db.password_reset_tokens.updateMany({
    where: { user_id: userId, used_at: null },
    data: { used_at: new Date() },
  })
  const token = newInviteToken()
  await db.password_reset_tokens.create({
    data: { token_hash: hashInviteToken(token), user_id: userId, expires_at: new Date(Date.now() + ttlMs) },
  })
  return `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`
}
