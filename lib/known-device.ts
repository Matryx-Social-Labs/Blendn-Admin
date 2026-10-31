// Relative imports, as lib/auth.ts.
import { createHash, createHmac, timingSafeEqual } from "crypto"

/*
 * "This browser has signed in to this account before": the escape from a
 * lockout a stranger spent against an address (security review of
 * fix/security-auth, M2). The per-email sign-in windows refuse even the right
 * password, so without this a spray keeps an operator out for as long as it
 * lasts. A successful sign-in sets this cookie; a sign-in that presents a valid
 * one for the typed email skips the per-email windows (the per-network one
 * still applies, and the password is still required).
 *
 * HMAC over the email and the issue time with NEXTAUTH_SECRET, so it cannot be
 * made for another address or back-dated, and nothing in it names a person. One
 * cookie per address (the name carries a hash of it), so an operator with two
 * accounts in one browser keeps both. Not revoked by a password reset: it only
 * waives a rate limit, and the new password is still needed.
 */
const MAX_AGE_SECONDS = 90 * 24 * 60 * 60
const SKEW_MS = 60 * 1000

export const KNOWN_DEVICE_MAX_AGE_SECONDS = MAX_AGE_SECONDS

const nameFor = (email: string) => `blendn_kd_${createHash("sha256").update(email).digest("hex").slice(0, 16)}`
const sign = (secret: string, email: string, issuedAt: number) =>
  createHmac("sha256", secret).update(`known-device|${email}|${issuedAt}`).digest("base64url")

/** The cookie to set after a successful sign-in; null when there is no secret to sign with. */
export function knownDeviceCookie(email: string, now: number = Date.now()): { name: string; value: string } | null {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) return null
  return { name: nameFor(email), value: `${now}.${sign(secret, email, now)}` }
}

/** Whether the request's Cookie header carries a valid, unexpired proof for exactly this email. */
export function isKnownDevice(email: string, cookieHeader: unknown, now: number = Date.now()): boolean {
  if (typeof cookieHeader !== "string") return false
  const name = nameFor(email)
  const pair = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))
  return pair !== undefined && isKnownDeviceProof(email, pair.slice(name.length + 1), now)
}

/**
 * The same proof without the cookie: the phone keeps the value a sign-in returned (`knownDevice`) and sends it back
 * with the next one (mobile sign-in, owner ruling A-18 (1)).
 */
export function isKnownDeviceProof(email: string, value: unknown, now: number = Date.now()): boolean {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret || typeof value !== "string") return false
  const [issued, mac, ...rest] = value.split(".")
  const issuedAt = Number(issued)
  if (rest.length || !mac || !Number.isInteger(issuedAt)) return false
  if (issuedAt > now + SKEW_MS || now - issuedAt > MAX_AGE_SECONDS * 1000) return false
  const given = Buffer.from(mac)
  const expected = Buffer.from(sign(secret, email, issuedAt))
  return given.length === expected.length && timingSafeEqual(given, expected)
}
