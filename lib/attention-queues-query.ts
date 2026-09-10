// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { SHAPE, type AttentionQueue } from "./attention-queues"
import { db } from "./db"

/**
 * The reads behind `lib/attention-queues.ts`, kept in a separate module.
 *
 * Not a taste call. The attention strip is a client component and needs the
 * pure half at runtime, so the pure half cannot import `db` — `lib/db.ts`
 * brings in `pg`, and `next build` fails outright when that reaches a browser
 * bundle. Neither `tsc` nor the 2418-test unit suite can see it: Jest's module
 * mapper resolves the import and never asks which bundle it lands in. The
 * build is the only layer that notices, which makes this exactly the class of
 * defect that reaches a deploy.
 */
/**
 * One round trip per source table, not two.
 *
 * The first version ran a `count` and a `findFirst(orderBy created_at)` per
 * table — sixteen queries for eight questions, all drawn from the same
 * connection pool on every admin page load. `aggregate` answers both at once,
 * and six of the eight tables already carry a `(status, created_at)` index that
 * covers it.
 */
async function pendingIn(
  model: { aggregate: (args: unknown) => Promise<{ _count: number; _min: { created_at: Date | null } }> },
  where: unknown
): Promise<{ count: number; oldest: Date | null }> {
  const row = await model.aggregate({ where, _count: true, _min: { created_at: true } })
  return { count: row._count, oldest: row._min.created_at }
}

/** The oldest of several aggregates, ignoring the empty ones. */
function earliest(parts: Array<{ oldest: Date | null }>): string | null {
  const times = parts.map((p) => p.oldest).filter((d): d is Date => d !== null)
  if (!times.length) return null
  return new Date(Math.min(...times.map((t) => t.getTime()))).toISOString()
}

const sum = (parts: Array<{ count: number }>) => parts.reduce((n, p) => n + p.count, 0)

/**
 * Every queue, always all four rows — including the empty ones.
 *
 * An empty queue is a fact worth rendering: "0 flags and reports, clear" is what
 * makes the strip's silence trustworthy. Dropping empty rows would make a clear
 * queue and a queue nobody counted look identical, which is exactly the failure
 * this module exists to close.
 */
export async function attentionQueues(): Promise<AttentionQueue[]> {
  const pending = { status: "pending" as const }

  const [
    flags,
    userReports,
    messageReports,
    eventClaims,
    venueClaims,
    brandClaims,
    applications,
    creatives,
  ] = await Promise.all([
    pendingIn(db.moderation_flags as never, pending),
    pendingIn(db.user_reports as never, pending),
    pendingIn(db.message_reports as never, pending),
    pendingIn(db.event_claims as never, pending),
    pendingIn(db.venue_claims as never, pending),
    pendingIn(db.sponsor_claims as never, pending),
    /*
     * `email_pending` counts, and that is not an oversight.
     *
     * An application whose email is unverified is still an organiser who
     * applied and is still waiting — the reviewer can see it and act on it.
     * `app/dashboard/layout.tsx` has always counted both for the badge, so
     * narrowing here would have made the strip quieter than the badge beside it
     * in precisely the case this module exists to prevent.
     */
    pendingIn(db.organiser_onboarding_requests as never, {
      status: { in: ["pending", "email_pending"] },
    }),
    pendingIn(db.sponsored_creatives as never, { moderation_status: "pending" }),
  ])

  const moderation = [flags, userReports, messageReports]
  const claims = [eventClaims, venueClaims, brandClaims]

  return [
    { ...SHAPE.moderation, count: sum(moderation), oldest: earliest(moderation) },
    { ...SHAPE.claims, count: sum(claims), oldest: earliest(claims) },
    { ...SHAPE.applications, count: applications.count, oldest: earliest([applications]) },
    { ...SHAPE.creative, count: creatives.count, oldest: earliest([creatives]) },
  ]
}
