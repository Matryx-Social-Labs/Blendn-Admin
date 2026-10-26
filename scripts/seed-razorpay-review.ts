/**
 * The dashboard account Razorpay's website reviewer signs in with
 * (docs/RAZORPAY-SUBMISSION.md).
 *
 *   npm run seed:razorpay-review                     # dry run: says what it would do
 *   RAZORPAY_REVIEW_PASSWORD=... npm run seed:razorpay-review -- --apply
 *   npm run seed:razorpay-review -- --remove --apply # after approval: tear it down
 *   ... --apply --production                         # production: the owner runs or approves this
 *
 * (`npm run` eats `--flags` on npm 11; if it does, call `npx tsx
 * scripts/seed-razorpay-review.ts --apply` directly.)
 *
 * ## What it makes
 *
 * One organiser, never an admin, as the owner of its OWN organisation, with
 * one draft event at a free-text venue. An organiser because that is the role
 * the Plan page sells to — Analytics and the Event Pass, with Razorpay
 * Checkout (`app/dashboard/plan/page.tsx`); a venue owner's Venue Pro is
 * refused until a venue has four weeks of data, so a fresh demo venue would
 * show the reviewer a locked button. Its own organisation, so it sees a
 * realistic dashboard and nobody else's people.
 *
 * ## Why app users never see any of it
 *
 * `review_demo` is not an exclusion: it is the App Review geofence bypass,
 * and the App Store review event is public on purpose. What hides an event
 * from every attendee read is `status = 'draft'`: lists ask for `published`,
 * and a single-event read answers not found for a draft
 * (`attendeeEventAccess`, lib/event-access.ts). It is also `private`, so
 * publishing it by accident still lists it to nobody. There is no `venues`
 * row — a venue nobody claimed is listed in Places, and the event's
 * `venue_name` is only text. The account has no profile, check-in or RSVP,
 * so it is in no room, roster or match list.
 *
 * ## Where it may run
 *
 * Staging and a database on this machine, like `scripts/test-accounts.ts`.
 * Anything else — production — only with `--production`, which the owner
 * passes. The password comes from `RAZORPAY_REVIEW_PASSWORD` and is never
 * printed: only the email and ids are.
 *
 * ## Idempotent
 *
 * Found by email, organisation name and event slug, so a second run changes
 * nothing but the password (re-hashed only when it changed) and puts back a
 * suspension, deletion or role somebody changed. Each applied run writes one
 * audit row on the organisation.
 */
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

import { auditInTx } from "../lib/audit-log"
import { syncOccurrences } from "../lib/occurrences"
import { checkPassword } from "../lib/password"

export const REVIEW_EMAIL_DEFAULT = "razorpay.review@blendn.app"
export const REVIEW_ORG_NAME = "Demo Events Co (Razorpay review)"
export const REVIEW_EVENT_SLUG = "razorpay-review-demo-event"
/** The one role this script ever gives. Never `app_admin`: that reads every real user. */
export const REVIEW_ROLE = "organizer" as const

/** Same cost as `test-accounts.ts`. */
const HASH_COST = 12
const DAY_MS = 24 * 60 * 60 * 1000
const EVENT_LEAD_DAYS = 14
const EVENT_HOURS = 4

type Env = Record<string, string | undefined>
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

export interface Flags {
  apply: boolean
  remove: boolean
  production: boolean
}

export function parseFlags(argv: readonly string[]): Flags {
  return { apply: argv.includes("--apply"), remove: argv.includes("--remove"), production: argv.includes("--production") }
}

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname
  } catch {
    return "(unparseable DATABASE_URL)"
  }
}

/** Why this database must not be touched, or null when it may. */
export function environmentRefusal(env: Env, flags: Pick<Flags, "production">): string | null {
  const name = env.RAILWAY_ENVIRONMENT_NAME
  if (name === "staging") return null
  if (!name && LOCAL_HOSTS.has(hostOf(env.DATABASE_URL))) return null
  if (flags.production) return null
  return (
    `${name ? `Railway environment "${name}"` : hostOf(env.DATABASE_URL)} is neither staging nor a local database. ` +
    "Production needs --production, which the owner passes."
  )
}

export interface ReviewWorld {
  email: string
  orgName: string
  eventSlug: string
}

export function worldFrom(env: Env): ReviewWorld {
  return {
    email: (env.RAZORPAY_REVIEW_EMAIL?.trim() || REVIEW_EMAIL_DEFAULT).toLowerCase(),
    orgName: REVIEW_ORG_NAME,
    eventSlug: REVIEW_EVENT_SLUG,
  }
}

export interface Seeded {
  userId: string
  orgId: string
  eventId: string
}

/**
 * Create or repair the account, its organisation and its draft event.
 * Refuses (before any query) a database it may not touch, a password the
 * product would refuse, and an organisation by that name that has somebody
 * else in it.
 */
export async function ensureRazorpayReviewAccount(
  db: PrismaClient,
  password: string,
  world: ReviewWorld,
  env: Env,
  flags: Pick<Flags, "production">
): Promise<Seeded> {
  const refusal = environmentRefusal(env, flags)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)
  if (!password) throw new Error("RAZORPAY_REVIEW_PASSWORD is not set")
  const check = checkPassword(password, world.email)
  if (!check.ok) throw new Error(`RAZORPAY_REVIEW_PASSWORD refused: ${check.message}`)

  const userId = await upsertUser(db, world.email, password)
  const orgId = await upsertOrg(db, world.orgName, userId)

  await db.organisation_members.upsert({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
    update: { role: "owner" },
    create: { org_id: orgId, user_id: userId, role: "owner", is_primary_contact: true },
  })

  const eventId = await upsertEvent(db, world.eventSlug, userId, orgId)

  await auditInTx(db, {
    action: "razorpay_review.seeded",
    resource: "organisation",
    resourceId: orgId,
    orgId,
    details: { userId, eventId, email: world.email, environment: env.RAILWAY_ENVIRONMENT_NAME ?? hostOf(env.DATABASE_URL) },
  })
  return { userId, orgId, eventId }
}

async function upsertUser(db: PrismaClient, email: string, password: string): Promise<string> {
  const existing = await db.user.findUnique({ where: { email }, select: { id: true, password: true } })
  if (!existing) {
    const created = await db.user.create({
      data: {
        email,
        name: "Razorpay Reviewer",
        password: await bcrypt.hash(password, HASH_COST),
        role: REVIEW_ROLE,
        // Verified, or a Google sign-in at this address would take the account
        // over and null the password (`seed-review-account.ts`).
        emailVerified: new Date(),
      },
      select: { id: true },
    })
    return created.id
  }
  const unchanged = existing.password ? await bcrypt.compare(password, existing.password) : false
  await db.user.update({
    where: { id: existing.id },
    data: {
      role: REVIEW_ROLE,
      deletedAt: null,
      suspended_at: null,
      suspended_by: null,
      suspension_reason: null,
      emailVerified: new Date(),
      ...(!unchanged && { password: await bcrypt.hash(password, HASH_COST) }),
    },
  })
  return existing.id
}

/** Its own organisation: refused if anyone but the reviewer has ever been a member. */
async function upsertOrg(db: PrismaClient, displayName: string, userId: string): Promise<string> {
  const existing = await db.organisations.findFirst({
    where: { display_name: displayName },
    select: { id: true, members: { select: { user_id: true } } },
  })
  if (!existing) {
    const created = await db.organisations.create({
      data: { display_name: displayName, kind: "company", status: "verified", verified_at: new Date() },
      select: { id: true },
    })
    return created.id
  }
  const others = existing.members.filter((m) => m.user_id !== userId)
  if (others.length > 0) {
    throw new Error(`"${displayName}" has ${others.length} other member(s); it is not the review organisation. Nothing written.`)
  }
  await db.organisations.update({
    where: { id: existing.id },
    data: { status: "verified", suspended_at: null, suspension_reason: null },
  })
  return existing.id
}

/** A draft, private event two weeks out; moved forward if a past run's has gone by. */
async function upsertEvent(db: PrismaClient, slug: string, userId: string, orgId: string): Promise<string> {
  const start = new Date(Date.now() + EVENT_LEAD_DAYS * DAY_MS)
  start.setUTCMinutes(30, 0, 0)
  const end = new Date(start.getTime() + EVENT_HOURS * 60 * 60 * 1000)
  const existing = await db.events.findUnique({ where: { slug }, select: { id: true, start_time: true, end_time: true } })

  const hidden = { status: "draft", visibility: "private", deleted_at: null, organizer_id: userId, organizer_org_id: orgId } as const
  if (existing) {
    const stale = existing.start_time.getTime() < Date.now()
    await db.events.update({ where: { id: existing.id }, data: { ...hidden, ...(stale && { start_time: start, end_time: end }) } })
    await syncOccurrences(existing.id, stale ? start : existing.start_time, stale ? end : existing.end_time, "Asia/Kolkata")
    return existing.id
  }
  const created = await db.events.create({
    data: {
      ...hidden,
      slug,
      kind: "event",
      title: "Rooftop Sessions: Live Set (demo)",
      description:
        "A demo event for reviewing the dashboard. An evening of live music on a rooftop: doors at 7, first set at 8. " +
        "It is a draft and is never shown in the Blend'n app.",
      short_description: "Demo event for the dashboard review",
      venue_name: "The Rooftop (demo venue)",
      address: "MG Road, Bengaluru",
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      latitude: 12.9756,
      longitude: 77.6068,
      start_time: start,
      end_time: end,
      timezone: "Asia/Kolkata",
      max_capacity: 120,
    },
    select: { id: true },
  })
  // Every event the dashboard makes has its occurrences; the event pages read them.
  await syncOccurrences(created.id, start, end, "Asia/Kolkata")
  return created.id
}

export interface Removed {
  userId: string | null
  orgId: string | null
  eventsDeleted: number
  orgDeleted: boolean
  billingRowsKept: number
}

/**
 * Take it all down after approval. The event goes; the membership goes; the
 * account is closed (deleted and suspended, password cleared — the product's
 * own soft delete, so a later `--apply` can bring it back); the organisation
 * is deleted unless it has billing records, which are tax records and keep it
 * (suspended) — `billing_checkouts.org_id` is Restrict for that reason.
 */
export async function removeRazorpayReviewAccount(
  db: PrismaClient,
  world: ReviewWorld,
  env: Env,
  flags: Pick<Flags, "production">
): Promise<Removed> {
  const refusal = environmentRefusal(env, flags)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)

  const user = await db.user.findUnique({ where: { email: world.email }, select: { id: true } })
  const org = await db.organisations.findFirst({
    where: { display_name: world.orgName },
    select: { id: true, members: { select: { user_id: true } } },
  })
  if (org && org.members.some((m) => m.user_id !== user?.id)) {
    throw new Error(`"${world.orgName}" has other members; it is not the review organisation. Nothing removed.`)
  }

  const { count: eventsDeleted } = await db.events.deleteMany({
    where: { slug: world.eventSlug, ...(org ? { organizer_org_id: org.id } : {}) },
  })

  let orgDeleted = false
  let billingRowsKept = 0
  if (org) {
    await db.organisation_members.deleteMany({ where: { org_id: org.id } })
    billingRowsKept = await db.billing_checkouts.count({ where: { org_id: org.id } })
    if (billingRowsKept === 0) {
      await db.organisations.delete({ where: { id: org.id } })
      orgDeleted = true
    } else {
      await db.organisations.update({
        where: { id: org.id },
        data: { status: "suspended", suspended_at: new Date(), suspension_reason: "Razorpay review finished" },
      })
    }
  }

  if (user) {
    await db.user.update({
      where: { id: user.id },
      data: {
        deletedAt: new Date(),
        suspended_at: new Date(),
        suspension_reason: "Razorpay review account removed",
        password: null,
        sessions_revoked_at: new Date(),
      },
    })
  }

  if (user || org) {
    // On the organisation while it exists; the platform's alone once it is gone.
    const onOrg = org && !orgDeleted
    await auditInTx(db, {
      action: "razorpay_review.removed",
      resource: onOrg ? "organisation" : "user",
      resourceId: onOrg ? org.id : user?.id,
      orgId: onOrg ? org.id : null,
      details: { userId: user?.id ?? null, orgId: org?.id ?? null, eventsDeleted, orgDeleted, billingRowsKept },
    })
  }
  return { userId: user?.id ?? null, orgId: org?.id ?? null, eventsDeleted, orgDeleted, billingRowsKept }
}

/* -------------------------------------------------------------------------- */

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const world = worldFrom(process.env)
  const where = `${hostOf(process.env.DATABASE_URL)} (${process.env.RAILWAY_ENVIRONMENT_NAME ?? "no Railway environment"})`
  console.log(`Razorpay review account → ${where}`)

  const refusal = environmentRefusal(process.env, flags)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)
  if (flags.production) console.log("  --production: the owner runs or approves this step")

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    if (!flags.apply) {
      const [user, org, event] = await Promise.all([
        db.user.findUnique({ where: { email: world.email }, select: { id: true, role: true, deletedAt: true } }),
        db.organisations.findFirst({ where: { display_name: world.orgName }, select: { id: true, status: true } }),
        db.events.findUnique({ where: { slug: world.eventSlug }, select: { id: true, status: true } }),
      ])
      console.log(`  DRY RUN — nothing written. Would ${flags.remove ? "remove" : "create or repair"}:`)
      console.log(`  user   ${world.email}  ${user ? `${user.id} (${user.role}${user.deletedAt ? ", deleted" : ""})` : "(new)"}`)
      console.log(`  org    ${world.orgName}  ${org ? `${org.id} (${org.status})` : "(new)"}`)
      console.log(`  event  ${world.eventSlug}  ${event ? `${event.id} (${event.status})` : "(new)"}`)
      console.log(`  Run again with --apply${flags.remove ? "" : " and RAZORPAY_REVIEW_PASSWORD set"}.`)
      return
    }
    if (flags.remove) {
      const r = await removeRazorpayReviewAccount(db, world, process.env, flags)
      console.log(`  removed: user ${r.userId ?? "(none)"} closed, ${r.eventsDeleted} event(s) deleted,`)
      console.log(
        r.orgDeleted
          ? `  organisation ${r.orgId} deleted`
          : r.orgId
            ? `  organisation ${r.orgId} kept and suspended: ${r.billingRowsKept} billing record(s) are tax records`
            : "  no organisation found"
      )
      return
    }
    const s = await ensureRazorpayReviewAccount(db, process.env.RAZORPAY_REVIEW_PASSWORD ?? "", world, process.env, flags)
    // The address and ids, never the password.
    console.log("  Razorpay review account ready.")
    console.log(`  email         ${world.email}  (role ${REVIEW_ROLE}, owner of its organisation)`)
    console.log(`  user id       ${s.userId}`)
    console.log(`  org id        ${s.orgId}  "${world.orgName}"`)
    console.log(`  event id      ${s.eventId}  (draft, private: never in the app)`)
    console.log("  Password: the value of RAZORPAY_REVIEW_PASSWORD. Put both in Razorpay's website details form.")
  } finally {
    await db.$disconnect()
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
