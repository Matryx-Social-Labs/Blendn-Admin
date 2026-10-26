/**
 * The dashboard account Razorpay's website reviewer signs in with
 * (docs/RAZORPAY-SUBMISSION.md).
 *
 *   npx tsx scripts/seed-razorpay-review.ts                     # dry run: says what it would do
 *   read -s RAZORPAY_REVIEW_PASSWORD; export RAZORPAY_REVIEW_PASSWORD
 *   npx tsx scripts/seed-razorpay-review.ts --apply             # create, or repair what it made
 *   npx tsx scripts/seed-razorpay-review.ts --remove --apply    # after approval: take it down
 *   ... --production                                            # production: the owner runs or approves it
 *
 * No npm script on purpose: npm 11 eats `--flags`, and touching package.json
 * puts a PR under the dependency audit gate.
 *
 * ## What it makes
 *
 * `razorpay.review@blendn.app`, an organizer (never an admin), owning its own
 * organisation with one draft, private event at a free-text venue. An
 * organizer because that is the role the Plan page sells to, with Razorpay
 * Checkout; a venue owner's Venue Pro is refused until a venue has four weeks
 * of data. Its own organisation, so it sees no real person's data.
 *
 * ## It never takes over an account it did not make
 *
 * What it made is what a `razorpay_review.seeded` audit row names: the user,
 * the organisation (the row's resource) and the event. Never an email match,
 * a name or a slug. So it refuses, writing nothing, when:
 *
 * - somebody already has the address and no seeded row names them;
 * - its user is in any other organisation, or its organisation has anybody else;
 * - its user's role was changed (an admin did that on purpose), or an admin
 *   suspended it (moderation is never undone by a re-run).
 *
 * ## Nothing reaches a real person
 *
 * The event is a draft (every attendee read refuses one: lists ask for
 * `published`, `attendeeEventAccess` answers not found) and private. The
 * server refuses to publish any of the organisation's events, add a venue,
 * link a venue or invite anyone (`lib/review-demo-org.ts`); the mobile
 * app refuses an organizer's sign-in (`accountBlockReason`: "staff").
 * `review_demo` is not used: it is the App Review geofence bypass, not a
 * hiding rule.
 *
 * ## Where it may run
 *
 * Staging and a database on this machine, like `scripts/test-accounts.ts`;
 * anything else only with `--production`, which the owner passes. The
 * password comes from `RAZORPAY_REVIEW_PASSWORD` and is never printed.
 *
 * ## Idempotent
 *
 * A re-run finds its rows by the ids in the last seeded audit row, resets the
 * password (re-hashed only when it changed) and makes nothing twice. The
 * writes are one transaction; the event's occurrences are synced after it
 * commits (`syncOccurrences` uses the app's own client), and a re-run
 * repairs them if that step failed.
 */
import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

import { auditInTx } from "../lib/audit-log"
import { realEventsWhere } from "../lib/event-kind"
import { syncOccurrences } from "../lib/occurrences"
import { checkPassword } from "../lib/password"
import { RAZORPAY_REVIEW_REMOVED, RAZORPAY_REVIEW_SEEDED } from "../lib/review-demo-org"

export const REVIEW_EMAIL = "razorpay.review@blendn.app"
export const REVIEW_ORG_NAME = "Demo Events Co (Razorpay review)"
/** The one role this script ever gives. Never `app_admin`: that reads every real user. */
export const REVIEW_ROLE = "organizer" as const
/** Written on the account by `--remove`; the only suspension a re-run may lift. */
export const REMOVED_REASON = "Razorpay review account removed"

/** Same cost as `test-accounts.ts`. */
const HASH_COST = 12
const DAY_MS = 24 * 60 * 60 * 1000
const EVENT_LEAD_DAYS = 14
const EVENT_HOURS = 4
const TIMEZONE = "Asia/Kolkata"

type Env = Record<string, string | undefined>
type Tx = Prisma.TransactionClient
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

/** The address and the organisation's name. Fixed: tests pass their own, nothing else does. */
export interface ReviewWorld {
  email: string
  orgName: string
}

export const WORLD: ReviewWorld = { email: REVIEW_EMAIL, orgName: REVIEW_ORG_NAME }

export interface Seeded {
  userId: string
  orgId: string
  eventId: string
}

/** What the last seeded row says this script made for that user, or null if it never made them. */
async function madeBefore(db: Tx, userId: string): Promise<{ orgId: string; eventId: string | null } | null> {
  const row = await db.audit_logs.findFirst({
    where: { action: RAZORPAY_REVIEW_SEEDED, details: { path: ["userId"], equals: userId } },
    orderBy: { created_at: "desc" },
    select: { resource_id: true, details: true },
  })
  if (!row?.resource_id) return null
  const details = (row.details ?? {}) as { eventId?: unknown }
  return { orgId: row.resource_id, eventId: typeof details.eventId === "string" ? details.eventId : null }
}

class Refused extends Error {}

/** The existing account's state, refused unless it is ours and nobody has moderated it. */
async function ourAccount(db: Tx, email: string) {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, role: true, password: true, deletedAt: true, suspended_at: true, suspension_reason: true },
  })
  if (!user) return null
  const prior = await madeBefore(db, user.id)
  if (!prior) throw new Refused(`${email} belongs to an account this script did not create. Nothing written.`)
  if (user.role !== REVIEW_ROLE) {
    throw new Refused(`${email} has role ${user.role}; somebody changed it. Nothing written — change it back by hand if that was a mistake.`)
  }
  const ourRemoval = user.suspension_reason === REMOVED_REASON
  if ((user.suspended_at || user.deletedAt) && !ourRemoval) {
    throw new Refused(`${email} was suspended or deleted by somebody else. A re-run does not undo moderation. Nothing written.`)
  }
  const others = await db.organisation_members.count({ where: { user_id: user.id, org_id: { not: prior.orgId } } })
  if (others > 0) throw new Refused(`${email} is in ${others} other organisation(s). Nothing written.`)
  return { user, prior }
}

/**
 * Create the account, its organisation and its draft event, or repair what an
 * earlier run made. Refuses (before any query) a database it may not touch and
 * a password the product would refuse; refuses (before any write) anything it
 * did not make.
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
  const fresh = await bcrypt.hash(password, HASH_COST)

  const seeded = await db.$transaction(async (tx) => {
    const ours = await ourAccount(tx, world.email)
    const userId = ours ? await repairUser(tx, ours.user, password, fresh) : await createUser(tx, world.email, fresh)
    const orgId = await ensureOrg(tx, ours?.prior.orgId ?? null, world.orgName, userId)
    const eventId = await ensureEvent(tx, ours?.prior.eventId ?? null, userId, orgId)
    await auditInTx(tx, {
      action: RAZORPAY_REVIEW_SEEDED,
      resource: "organisation",
      resourceId: orgId,
      orgId,
      details: { userId, eventId, email: world.email, environment: env.RAILWAY_ENVIRONMENT_NAME ?? hostOf(env.DATABASE_URL) },
    })
    return { userId, orgId, eventId }
  })

  // After the commit: `syncOccurrences` writes through the app's own client.
  const event = await db.events.findUniqueOrThrow({ where: { id: seeded.eventId }, select: { start_time: true, end_time: true } })
  await syncOccurrences(seeded.eventId, event.start_time, event.end_time, TIMEZONE)
  return seeded
}

async function createUser(tx: Tx, email: string, hash: string): Promise<string> {
  const created = await tx.user.create({
    data: {
      email,
      name: "Razorpay Reviewer",
      password: hash,
      role: REVIEW_ROLE,
      // Verified, or a Google sign-in at this address would take the account
      // over and null the password (`seed-review-account.ts`).
      emailVerified: new Date(),
    },
    select: { id: true },
  })
  return created.id
}

async function repairUser(
  tx: Tx,
  user: { id: string; password: string | null; deletedAt: Date | null; suspension_reason: string | null },
  password: string,
  hash: string
): Promise<string> {
  const unchanged = user.password ? await bcrypt.compare(password, user.password) : false
  await tx.user.update({
    where: { id: user.id },
    data: {
      ...(!unchanged && { password: hash }),
      // Only our own `--remove` is lifted; `ourAccount` refused anything else.
      ...(user.suspension_reason === REMOVED_REASON && {
        deletedAt: null,
        suspended_at: null,
        suspended_by: null,
        suspension_reason: null,
      }),
    },
  })
  return user.id
}

/** The organisation an earlier run made, by id; a new one if there is none. Never one found by name. */
async function ensureOrg(tx: Tx, priorOrgId: string | null, name: string, userId: string): Promise<string> {
  const prior = priorOrgId
    ? await tx.organisations.findUnique({ where: { id: priorOrgId }, select: { id: true, members: { select: { user_id: true } } } })
    : null
  if (prior && prior.members.some((m) => m.user_id !== userId)) {
    throw new Refused(`The review organisation ${prior.id} has other members. Nothing written.`)
  }
  const orgId = prior
    ? (
        await tx.organisations.update({
          where: { id: prior.id },
          data: { status: "verified", suspended_at: null, suspension_reason: null },
          select: { id: true },
        })
      ).id
    : (
        await tx.organisations.create({
          data: { display_name: name, kind: "company", status: "verified", verified_at: new Date() },
          select: { id: true },
        })
      ).id
  await tx.organisation_members.upsert({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
    update: { role: "owner" },
    create: { org_id: orgId, user_id: userId, role: "owner", is_primary_contact: true },
  })
  return orgId
}

/** The event an earlier run made, by id, kept a draft; a new one if it is gone. */
async function ensureEvent(tx: Tx, priorEventId: string | null, userId: string, orgId: string): Promise<string> {
  const hidden = { status: "draft", visibility: "private", pre_suspension_status: null } as const
  const prior = priorEventId
    ? await tx.events.findFirst({
        where: { id: priorEventId, organizer_org_id: orgId, deleted_at: null, ...realEventsWhere },
        select: { id: true, start_time: true },
      })
    : null
  const start = new Date(Date.now() + EVENT_LEAD_DAYS * DAY_MS)
  start.setUTCMinutes(30, 0, 0)
  const end = new Date(start.getTime() + EVENT_HOURS * 60 * 60 * 1000)

  if (prior) {
    const stale = prior.start_time.getTime() < Date.now()
    await tx.events.update({ where: { id: prior.id }, data: { ...hidden, ...(stale && { start_time: start, end_time: end }) } })
    return prior.id
  }
  const created = await tx.events.create({
    data: {
      ...hidden,
      // Unique, and never looked up: the event is found by the id in the audit row.
      slug: `razorpay-review-demo-${Date.now().toString(36)}`,
      kind: "event",
      organizer_id: userId,
      organizer_org_id: orgId,
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
      timezone: TIMEZONE,
      max_capacity: 120,
    },
    select: { id: true },
  })
  return created.id
}

export interface Removed {
  userId: string | null
  orgId: string | null
  eventsDeleted: number
  venuesRetired: number
}

/**
 * Take it down after approval, in one transaction. Every event of the
 * organisation — whatever the reviewer renamed or added — is soft-deleted,
 * published ones first flipped to draft as an organisation suspension does
 * (`setOrganisationStatus`); soft, because an Event Pass or a payment points
 * at an event with ON DELETE RESTRICT and is a tax record. Venues it added,
 * unclaimed or still its own, are retired as `retireVenue` does. The
 * organisation is suspended (never deleted: billing rows are Restrict) and the
 * account closed with `REMOVED_REASON`, the one state a later `--apply` may
 * bring back. Refuses an account this script did not make.
 */
export async function removeRazorpayReviewAccount(
  db: PrismaClient,
  world: ReviewWorld,
  env: Env,
  flags: Pick<Flags, "production">
): Promise<Removed> {
  const refusal = environmentRefusal(env, flags)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)

  return db.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { email: world.email }, select: { id: true } })
    if (!user) return { userId: null, orgId: null, eventsDeleted: 0, venuesRetired: 0 }
    const prior = await madeBefore(tx, user.id)
    if (!prior) throw new Refused(`${world.email} belongs to an account this script did not create. Nothing removed.`)
    const orgId = prior.orgId
    const strangers = await tx.organisation_members.count({ where: { org_id: orgId, user_id: { not: user.id } } })
    if (strangers > 0) throw new Refused(`The review organisation ${orgId} has other members. Nothing removed.`)

    const now = new Date()
    await tx.events.updateMany({
      where: { organizer_org_id: orgId, ...realEventsWhere, status: "published", deleted_at: null },
      data: { status: "draft", pre_suspension_status: "published" },
    })
    const { count: eventsDeleted } = await tx.events.updateMany({
      where: { organizer_org_id: orgId, ...realEventsWhere, deleted_at: null },
      data: { deleted_at: now },
    })
    const { count: venuesRetired } = await tx.venues.updateMany({
      where: { created_by_org_id: orgId, deleted_at: null, OR: [{ owner_org_id: null }, { owner_org_id: orgId }] },
      data: { deleted_at: now, status: "archived" },
    })
    await tx.organisations.update({
      where: { id: orgId },
      data: { status: "suspended", suspended_at: now, suspension_reason: "Razorpay review finished" },
    })
    await tx.user.update({
      where: { id: user.id },
      data: { deletedAt: now, suspended_at: now, suspension_reason: REMOVED_REASON, password: null, sessions_revoked_at: now },
    })
    await auditInTx(tx, {
      action: RAZORPAY_REVIEW_REMOVED,
      resource: "organisation",
      resourceId: orgId,
      orgId,
      details: { userId: user.id, eventsDeleted, venuesRetired },
    })
    return { userId: user.id, orgId, eventsDeleted, venuesRetired }
  })
}

/* -------------------------------------------------------------------------- */

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const where = `${hostOf(process.env.DATABASE_URL)} (${process.env.RAILWAY_ENVIRONMENT_NAME ?? "no Railway environment"})`
  console.log(`Razorpay review account → ${where}`)

  const refusal = environmentRefusal(process.env, flags)
  if (refusal) throw new Error(`REFUSING: ${refusal}`)
  if (flags.production) console.log("  --production: the owner runs or approves this step")

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  try {
    if (!flags.apply) {
      const user = await db.user.findUnique({ where: { email: WORLD.email }, select: { id: true, role: true, deletedAt: true } })
      const prior = user ? await madeBefore(db, user.id) : null
      console.log(`  DRY RUN — nothing written. Would ${flags.remove ? "remove" : "create or repair"}:`)
      console.log(`  user   ${WORLD.email}  ${user ? `${user.id} (${user.role}${user.deletedAt ? ", closed" : ""})` : "(new)"}`)
      if (user && !prior) console.log("  !  that address belongs to an account this script did not create: --apply will refuse")
      console.log(`  org    ${prior?.orgId ?? "(new)"}`)
      console.log(`  event  ${prior?.eventId ?? "(new)"}`)
      console.log(`  Run again with --apply${flags.remove ? "" : " and RAZORPAY_REVIEW_PASSWORD exported"}.`)
      return
    }
    if (flags.remove) {
      const r = await removeRazorpayReviewAccount(db, WORLD, process.env, flags)
      console.log(
        r.userId
          ? `  removed: user ${r.userId} closed, organisation ${r.orgId} suspended, ${r.eventsDeleted} event(s) deleted, ${r.venuesRetired} venue(s) retired`
          : "  nothing to remove"
      )
      return
    }
    const s = await ensureRazorpayReviewAccount(db, process.env.RAZORPAY_REVIEW_PASSWORD ?? "", WORLD, process.env, flags)
    // The address and ids, never the password.
    console.log("  Razorpay review account ready.")
    console.log(`  email         ${WORLD.email}  (role ${REVIEW_ROLE}, owner of its organisation)`)
    console.log(`  user id       ${s.userId}`)
    console.log(`  org id        ${s.orgId}  "${WORLD.orgName}"`)
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
