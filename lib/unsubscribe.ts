// Relative imports: reached from server.ts through the reminder sweeper and the results mail (build:server).
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"

import { db } from "./db"
import { canonicalEmail, dashboardUrl } from "./email"

/**
 * The one-click unsubscribe from lifecycle mail (SCRUM-1282, RFC 8058).
 *
 * The token is `<user id>.<HMAC-SHA256 over the canonical address>`: the address is never in the URL, and the link
 * stops working if the account's address changes or the account is deleted (the next mail carries a fresh one). No
 * expiry: an unsubscribe link has to work for as long as the mail sits in an inbox.
 *
 * The key is derived from NEXTAUTH_SECRET with HKDF under its own label, so this MAC can never stand in for a session
 * signature or any other use of that secret.
 */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/

function key(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error("NEXTAUTH_SECRET is not set: unsubscribe links cannot be signed")
  return Buffer.from(hkdfSync("sha256", secret, "", "blendn:unsubscribe:v1", 32))
}

const mac = (email: string) => createHmac("sha256", key()).update(canonicalEmail(email), "utf8").digest()

export function unsubscribeToken(user: { id: string; email: string }): string {
  return `${user.id}.${mac(user.email).toString("base64url")}`
}

/** `<dashboard>/api/email/unsubscribe?t=<token>`: the List-Unsubscribe URL and the footer link. */
export function unsubscribeUrl(user: { id: string; email: string }): string {
  return `${dashboardUrl()}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(user))}`
}

/** Constant-time on the MAC. Never throws on input. */
export function verifyUnsubscribeToken(token: unknown, user: { id: string; email: string }): boolean {
  if (typeof token !== "string") return false
  const [id, given, extra] = token.split(".")
  if (id !== user.id || !given || extra !== undefined) return false
  const presented = Buffer.from(given, "base64url")
  const expected = mac(user.email)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

/** The canonical address a token unsubscribes, or null for a token that is not ours. Reads; never writes. */
export async function unsubscribeTarget(token: unknown): Promise<string | null> {
  if (typeof token !== "string") return null
  const id = token.split(".")[0]
  if (!USER_ID.test(id)) return null
  const user = await db.user.findUnique({ where: { id }, select: { id: true, email: true, deletedAt: true } })
  if (!user || user.deletedAt || !verifyUnsubscribeToken(token, user)) return null
  return canonicalEmail(user.email)
}

/**
 * Writes the `unsubscribe` suppression, which stops lifecycle mail only (`blocks` in lib/email.ts). An address already
 * suppressed keeps its row: a bounce or a complaint stops more, and is never downgraded to an unsubscribe.
 */
export async function unsubscribe(token: unknown): Promise<boolean> {
  const email = await unsubscribeTarget(token)
  if (!email) return false
  await db.email_suppressions.createMany({ data: [{ email, reason: "unsubscribe" }], skipDuplicates: true })
  return true
}
