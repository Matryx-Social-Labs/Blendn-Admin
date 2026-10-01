import { z } from "zod"

/**
 * What the two public claim actions accept, checked before anything else runs.
 *
 * Both are unauthenticated server actions, so their argument is whatever any
 * client sent: a TypeScript interface is erased at runtime. Every string is
 * capped here, before it reaches a regex, a query or a Redis key. The email
 * check is linear on purpose — the pattern it replaced backtracked, and 16k
 * characters held the event loop (shared with Socket.io) for ~450 ms a request.
 */

/** RFC 5321's limit on a forward path. */
export const CLAIM_EMAIL_MAX = 254
export const CLAIM_NOTE_MAX = 1000

const id = z.string().max(64)

export const claimEventInput = z.object({
  eventId: id,
  contactEmail: z.string().max(CLAIM_EMAIL_MAX + 64),
  note: z.string().max(CLAIM_NOTE_MAX).optional(),
  onboardingId: id.optional(),
})

export const claimVenueInput = z.object({
  venueId: id,
  contactEmail: z.string().max(CLAIM_EMAIL_MAX + 64),
  onboardingId: id,
  gstin: z.string().max(20).optional(),
  note: z.string().max(CLAIM_NOTE_MAX).optional(),
})

/** The refusal for an input that failed its schema: the note is the one a person can exceed by hand. */
export function claimInputRefusal(error: z.ZodError): string {
  return error.issues.some((i) => i.path[0] === "note")
    ? "Keep the note under 1,000 characters"
    : "Check what you entered and try again"
}

/**
 * The address, trimmed and lowercased, or null when it is not one we can reply
 * to. One `@`, something before it, a dot inside the domain, no whitespace, at
 * most 254 characters. Linear in the length; nothing here can backtrack.
 */
export function claimEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase()
  if (email.length === 0 || email.length > CLAIM_EMAIL_MAX || /\s/.test(email)) return null
  const at = email.indexOf("@")
  if (at < 1 || at !== email.lastIndexOf("@")) return null
  const domain = email.slice(at + 1)
  const dot = domain.lastIndexOf(".")
  return dot > 0 && dot < domain.length - 1 ? email : null
}
