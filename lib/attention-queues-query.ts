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
/** The oldest of several `created_at` reads, ignoring the empty ones. */
function earliest(dates: Array<{ created_at: Date } | null>): string | null {
  const times = dates.filter((d): d is { created_at: Date } => d !== null).map((d) => d.created_at)
  if (!times.length) return null
  return new Date(Math.min(...times.map((t) => t.getTime()))).toISOString()
}

const oldestOf = { orderBy: { created_at: "asc" }, select: { created_at: true } } as const

/**
 * Every queue, always all four rows — including the empty ones.
 *
 * An empty queue is a fact worth rendering: "0 flagged messages, nothing since
 * 2 Sep" is what makes the strip's silence trustworthy. Dropping empty rows
 * would make a clear queue and a queue nobody counted look identical, which is
 * exactly the failure this module exists to close.
 */
export async function attentionQueues(): Promise<AttentionQueue[]> {
  const pending = { status: "pending" as const }

  const [
    flags,
    userReports,
    messageReports,
    oldestFlag,
    oldestUserReport,
    oldestMessageReport,
    eventClaims,
    venueClaims,
    brandClaims,
    oldestEventClaim,
    oldestVenueClaim,
    oldestBrandClaim,
    applications,
    oldestApplication,
    creatives,
    oldestCreative,
  ] = await Promise.all([
    db.moderation_flags.count({ where: pending }),
    db.user_reports.count({ where: pending }),
    db.message_reports.count({ where: pending }),
    db.moderation_flags.findFirst({ where: pending, ...oldestOf }),
    db.user_reports.findFirst({ where: pending, ...oldestOf }),
    db.message_reports.findFirst({ where: pending, ...oldestOf }),
    db.event_claims.count({ where: pending }),
    db.venue_claims.count({ where: pending }),
    db.sponsor_claims.count({ where: pending }),
    db.event_claims.findFirst({ where: pending, ...oldestOf }),
    db.venue_claims.findFirst({ where: pending, ...oldestOf }),
    db.sponsor_claims.findFirst({ where: pending, ...oldestOf }),
    /*
     * `email_pending` counts, and that is not an oversight.
     *
     * An application whose email is unverified is still an organiser who
     * applied and is still waiting — the reviewer can see it and act on it.
     * `app/dashboard/layout.tsx` has always counted both for the badge, so
     * narrowing here would have made the strip quieter than the badge beside it
     * in precisely the case this module exists to prevent.
     */
    db.organiser_onboarding_requests.count({
      where: { status: { in: ["pending", "email_pending"] } },
    }),
    db.organiser_onboarding_requests.findFirst({
      where: { status: { in: ["pending", "email_pending"] } },
      ...oldestOf,
    }),
    db.sponsored_creatives.count({ where: { moderation_status: "pending" } }),
    db.sponsored_creatives.findFirst({ where: { moderation_status: "pending" }, ...oldestOf }),
  ])

  return [
    {
      ...SHAPE.moderation,
      count: flags + userReports + messageReports,
      oldest: earliest([oldestFlag, oldestUserReport, oldestMessageReport]),
    },
    {
      ...SHAPE.claims,
      count: eventClaims + venueClaims + brandClaims,
      oldest: earliest([oldestEventClaim, oldestVenueClaim, oldestBrandClaim]),
    },
    { ...SHAPE.applications, count: applications, oldest: earliest([oldestApplication]) },
    { ...SHAPE.creative, count: creatives, oldest: earliest([oldestCreative]) },
  ]
}

