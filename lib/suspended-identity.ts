import { db } from "@/lib/db"

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"])

/**
 * One key per inbox: lower case, no `+tag`, and for Gmail no dots and one
 * domain, so `A.B+x@Gmail.com` and `ab@gmail.com` are the same person.
 */
export function identityEmail(email: string): string {
  const typed = email.trim().toLowerCase()
  const at = typed.lastIndexOf("@")
  const local = typed.slice(0, at).split("+")[0] || typed.slice(0, at)
  const domain = typed.slice(at + 1)
  return GMAIL_DOMAINS.has(domain) ? `${local.replaceAll(".", "")}@gmail.com` : `${local}@${domain}`
}

/**
 * Whether a new account for this email would be a suspended person's
 * (SCRUM-1172). Read before sign-up, Google or Apple creates a `User`.
 */
export async function isSuspendedIdentity(email: string): Promise<boolean> {
  const key = identityEmail(email)
  const domains = key.endsWith("@gmail.com") ? [...GMAIL_DOMAINS] : [key.slice(key.lastIndexOf("@") + 1)]
  // ponytail: reads every suspended row on the domain; fine while suspensions are few, a stored key column if not.
  const suspended = await db.user.findMany({
    where: { suspended_at: { not: null }, OR: domains.map((d) => ({ email: { endsWith: `@${d}` } })) },
    select: { email: true },
  })
  return suspended.some((user) => identityEmail(user.email) === key)
}
