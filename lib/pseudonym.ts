import { createHmac } from "crypto"

/**
 * A stable, non-reversible label for an attendee in an export.
 *
 * The exports call themselves pseudonymous and built the label as
 * `attendee-${userId.slice(0, 8)}` -- the first eight characters of the real
 * user id. That is not a pseudonym, it is an abbreviation. The same host is
 * handed full user ids for every chat participant by the messages route, so
 * prefix-matching one against the other recovers exactly who each
 * "pseudonymous" export row is. It also links the same attendee across every
 * event a host runs, which is the correlation a pseudonym exists to prevent.
 *
 * An HMAC keyed on a server secret is neither reversible nor correlatable
 * without the key. `scope` salts it per organisation so two hosts cannot
 * compare notes either -- the same attendee is a different label to each.
 *
 * Truncated to 12 hex characters: 48 bits, far beyond collision range for any
 * single export, and short enough to read in a spreadsheet.
 *
 * `NEXTAUTH_SECRET` rather than the mobile JWT key -- `lib/env.ts` already
 * requires it at 32+ characters and fails the boot without it, and a signing
 * key should not double as a hashing key.
 */
export function attendeeLabel(userId: string, scope: string): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    // Fail loudly rather than silently emitting a weak or empty-keyed label.
    throw new Error("NEXTAUTH_SECRET is required to build attendee pseudonyms")
  }

  const digest = createHmac("sha256", secret)
    .update(`${scope}:${userId}`)
    .digest("hex")
    .slice(0, 12)

  return `attendee-${digest}`
}
