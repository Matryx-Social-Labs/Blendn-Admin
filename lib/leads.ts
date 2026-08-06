import { timingSafeEqual } from "node:crypto"
import { z } from "zod"

/**
 * Ingesting a lead from the organiser landing page.
 *
 * The call is **server-to-server**: a Vercel function on
 * `organizers.blendn.app` forwards the demo form here with a bearer token. The
 * browser never touches this endpoint, which is why there is no CORS handling —
 * adding any would only invite someone to move the call into the browser later,
 * where the token would end up in a bundle.
 *
 * The rule this whole path exists to enforce: **never report success for a lead
 * that was not stored.** The previous implementation returned `{success:true}`
 * while the database was unconfigured, so every lead in that window was lost
 * and every visitor was told they were in.
 */

/** Everything the caller may send. Unknown keys are ignored, not rejected, so
 *  the landing page can add a field without a coordinated deploy. */
export const leadInputSchema = z
  .object({
    type: z.enum(["demo_request"]),
    source: z.string().trim().max(80).optional(),
    email: z.string().trim().toLowerCase().email(),
    submittedAt: z.string().datetime().optional(),
    userAgent: z.string().max(400).optional(),
    // The caller sends "" when it could not read one. Not `.ip()` — a bad value
    // should not fail the whole lead, it should just not be stored.
    ip: z.string().max(64).optional(),
    name: z.string().trim().max(120).optional(),
    organization: z.string().trim().max(160).optional(),
    eventTypes: z.string().trim().max(500).optional(),
    city: z.string().trim().max(120).optional(),
  })
  .passthrough()

export type LeadInput = z.infer<typeof leadInputSchema>

/**
 * Constant-time bearer check, with rotation.
 *
 * `===` on a secret leaks its length and matching prefix through timing.
 * `LANDING_INGEST_TOKEN` accepts a comma-separated list so rotating is two
 * deploys rather than a flag day: add the new token, update Vercel, drop the
 * old one.
 */
export function tokenOk(header: string | null | undefined): boolean {
  const configured = process.env.LANDING_INGEST_TOKEN
  if (!configured) return false
  if (!header?.startsWith("Bearer ")) return false

  const given = Buffer.from(header.slice(7))
  // Every candidate is compared even after a match, so the number of
  // comparisons does not reveal which token was used.
  let matched = false
  for (const candidate of configured.split(",")) {
    const want = Buffer.from(candidate.trim())
    if (want.length === 0) continue
    // Length is compared first because timingSafeEqual throws on a mismatch.
    // Length is not the secret; the bytes are.
    if (given.length === want.length && timingSafeEqual(given, want)) matched = true
  }
  return matched
}

/**
 * `sam+2@x.com` → `sam@x.com`, for abuse counting only.
 *
 * The contract's per-email cap claimed to catch plus-addressed floods, but a
 * counter keyed on the raw address cannot: `sam+1@` and `sam+2@` are different
 * strings. Stripping the tag is what makes that rule mean anything.
 *
 * Never used to contact anyone — `sam+blendn@` is a real, deliverable address
 * and mail sent to the stripped form may go somewhere else entirely. Storage
 * and display always use the address as given.
 */
export function emailRoot(email: string): string {
  const at = email.lastIndexOf("@")
  if (at <= 0) return email.toLowerCase()
  const local = email.slice(0, at)
  const domain = email.slice(at + 1).toLowerCase()
  const plus = local.indexOf("+")
  const root = plus === -1 ? local : local.slice(0, plus)
  // An all-tag local part ("+foo@x.com") would strip to "", which would then
  // collide with every other degenerate address.
  return `${(root || local).toLowerCase()}@${domain}`
}

/** Postgres refuses a malformed INET, and one bad header must not lose a lead. */
export function normaliseIp(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  // The caller sends the first hop of x-forwarded-for, but belt and braces:
  // a full chain would be rejected by INET.
  const first = value.split(",")[0].trim()
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/
  const ipv6 = /^[0-9a-fA-F:]+$/
  if (ipv4.test(first) && first.split(".").every((o) => Number(o) <= 255)) return first
  if (first.includes(":") && ipv6.test(first)) return first
  return null
}

/** Statuses that count as an open lead — the scope of idempotency. */
export const OPEN_LEAD_STATUSES = ["new", "contacted", "qualified"] as const
export const CLOSED_LEAD_STATUSES = ["converted", "archived", "spam"] as const

/**
 * The idempotency key, stored in `leads.open_key`.
 *
 * Non-null while the lead is open, NULL once it is finished — so a double-tap
 * or a Vercel retry collides, and a genuine request months later does not.
 * Postgres permits unlimited NULLs in a unique index, which is what makes this
 * expressible as a plain column rather than a partial index Prisma cannot
 * declare (and which would therefore exist in production but not in CI).
 */
export function openKey(type: string, email: string): string {
  return `${type}:${email.toLowerCase()}`
}

/**
 * What `open_key` must be for a given status. The single rule; every write path
 * that sets `status` must set `open_key` from this in the same statement.
 *
 * The column is application-managed rather than a Postgres generated column,
 * and that is a real tradeoff: a generated column could not drift, but it is
 * raw SQL Prisma cannot declare, so it would exist under `migrate deploy` in
 * production and be missing under `db push` in CI — the divergence this design
 * was chosen to avoid. If `leads` ever grows a second write path, revisit it.
 */
export function openKeyFor(
  status: string,
  type: string,
  email: string
): string | null {
  return (OPEN_LEAD_STATUSES as readonly string[]).includes(status)
    ? openKey(type, email)
    : null
}

/**
 * Rate limits.
 *
 * Keyed on values from the **body**, never on the request's IP. This is a
 * server-to-server call, so every lead arrives from the same Vercel egress
 * address; keying on `x-forwarded-for` would cap the whole world at five leads
 * an hour and 429 the sixth real visitor.
 */
export const LEAD_LIMITS = {
  perIp: { max: 5, windowMs: 60 * 60 * 1000 },
  perEmailRoot: { max: 3, windowMs: 24 * 60 * 60 * 1000 },
} as const

/** How long the personal fields are kept. `ip` and `user_agent` are PII. */
export const LEAD_PII_RETENTION_DAYS = 365
