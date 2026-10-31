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
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret || typeof cookieHeader !== "string") return false
  const name = nameFor(email)
  const pair = cookieHeader.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name}=`))
  if (!pair) return false
  const [issued, mac, ...rest] = pair.slice(name.length + 1).split(".")
  const issuedAt = Number(issued)
  if (rest.length || !mac || !Number.isInteger(issuedAt)) return false
  if (issuedAt > now + SKEW_MS || now - issuedAt > MAX_AGE_SECONDS * 1000) return false
  const given = Buffer.from(mac)
  const expected = Buffer.from(sign(secret, email, issuedAt))
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/*
 * The phone's version of the same escape (mobile sign-in, owner ruling A-18 (1)). Returned by a right sign-in as a
 * value, kept by the app, sent with its next sign-in. Narrower than the cookie on purpose, because a value in app storage
 * is easier to lift than an httpOnly cookie:
 * - its own HMAC domain, so it is never a dashboard cookie or the other way round;
 * - bound to one installation (`deviceInfo.installationId`), so it works only from the phone it was given to;
 * - bound to the account's password and its last sign-out everywhere, so a reset or "sign out of every device" kills it.
 * It does not lift the limit: the sign-in moves to the phone's own window instead of the account's (the route).
 */
export interface PhoneProofSubject {
  email: string
  installationId: string
  password: string | null
  sessionsRevokedAt: Date | null
}

/** The account's credential state: changes with a password change and with sign-out everywhere. */
const generationOf = (s: PhoneProofSubject) =>
  createHash("sha256").update(`${s.password ?? ""}|${s.sessionsRevokedAt?.getTime() ?? 0}`).digest("hex")

const signPhone = (secret: string, s: PhoneProofSubject, issuedAt: number) =>
  createHmac("sha256", secret)
    .update(["mobile-known-device", s.email, s.installationId, generationOf(s), issuedAt].join("|"))
    .digest("base64url")

/**
 * The name a known phone's sign-in windows count under: the installation and the account's credential state, so a
 * reset or sign-out everywhere starts the phone on fresh counters with its new proof (security review of SCRUM-944).
 */
export const phoneLimitKey = (s: PhoneProofSubject) => `${s.installationId}:${generationOf(s).slice(0, 16)}`

/** The proof to return after a right mobile sign-in; null when there is no secret to sign with. */
export function phoneKnownDeviceProof(subject: PhoneProofSubject, now: number = Date.now()): string | null {
  const secret = process.env.NEXTAUTH_SECRET
  return secret ? `${now}.${signPhone(secret, subject, now)}` : null
}

/** Whether `value` is a valid, unexpired proof for exactly this account, installation and credential state. */
export function isPhoneKnownDevice(subject: PhoneProofSubject, value: unknown, now: number = Date.now()): boolean {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret || typeof value !== "string") return false
  const [issued, mac, ...rest] = value.split(".")
  const issuedAt = Number(issued)
  if (rest.length || !mac || !Number.isInteger(issuedAt)) return false
  if (issuedAt > now + SKEW_MS || now - issuedAt > MAX_AGE_SECONDS * 1000) return false
  const given = Buffer.from(mac)
  const expected = Buffer.from(signPhone(secret, subject, issuedAt))
  return given.length === expected.length && timingSafeEqual(given, expected)
}
