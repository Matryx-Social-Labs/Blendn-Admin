import type { PrismaClient } from "@prisma/client"

import { environmentRefusal, upsertAccount, upsertOrg, type TestAccount } from "./test-accounts"
import { auditInTx } from "../lib/audit-log"
import { syncOccurrences } from "../lib/occurrences"
import { checkPassword } from "../lib/password"

/**
 * The two standing personas for the paid plans (SCRUM-561, test plan §11):
 *
 *   organizer.pro@blendn.app  owner of its own verified organisation, with a live
 *                             Analytics GRANT and three ended events above the floors
 *   venue.pro@blendn.app      owner of its own claimed venue, with a live Venue Pro GRANT
 *
 * Before these, the paid states of the dashboard could only be driven by
 * granting a throwaway organisation and cleaning up after. `organizer@` stays
 * free on purpose: it is the control.
 *
 * ## A grant is the honest shape
 *
 * No Razorpay row, no payment: a seeded persona must never look like a
 * purchase. The row is the one the Organisations / venue page writes
 * (`grantEntitlement`: product, `source: "grant"`, no reference), written here
 * because `lib/entitlements.ts` cannot load outside Next (`server-only`).
 * `__tests__/entitlements-boundary.test.ts` pins this file to that shape: two
 * products, source grant, only the two pro subjects.
 *
 * ## Idempotent, on every deploy
 *
 * Run by `scripts/test-accounts.ts` after the role accounts. A live grant is
 * left alone (so an admin who ended one by hand is given a fresh one on the
 * next deploy, which is what "standing persona" means); a missing account,
 * organisation, membership, venue or event is made; check-ins are upserted.
 * shortcut: no cross-process lock — Railway runs one pre-deploy per service at
 * a time; two concurrent runs could each write a grant. Add an advisory lock if
 * pre-deploys ever overlap.
 * Staging or a local database only (`environmentRefusal`).
 */

export const PRO_ORG_NAMES = { events: "Pro Collective (QA)", venues: "Pro Hospitality (QA)" } as const
export const PRO_VENUE_NAME = "Pro Hospitality Bar (QA)"
const GRANT_MONTHS = 12
const AUDIENCE = 12 // above the quartile floor (8) and the privacy floor (5)
const NIGHTS_AGO = [60, 45, 30] as const
const DAY_MS = 86_400_000

export const PRO_ACCOUNTS: readonly (TestAccount & { orgName: string })[] = [
  {
    key: "organiserPro",
    email: "organizer.pro@blendn.app",
    formerly: "",
    name: "Nisha Pro",
    role: "organizer",
    org: null,
    orgName: PRO_ORG_NAMES.events,
    note: "Owner of an organisation with a live Analytics grant and ended events. organizer@ is the free control.",
  },
  {
    key: "venuePro",
    email: "venue.pro@blendn.app",
    formerly: "",
    name: "Vikram Pro",
    role: "venue_owner",
    org: null,
    orgName: PRO_ORG_NAMES.venues,
    note: "Owner of a claimed venue with a live Venue Pro grant. venue.owner@ is the free control.",
  },
]

/** Everything a run writes, named: the integration test swaps in a namespaced one. */
export interface ProWorld {
  accounts: readonly (TestAccount & { orgName: string })[]
  venueName: string
  slugPrefix: string
  /** The synthetic people who fill the nights: never a real tester. */
  audiencePrefix: string
}
const PRO_WORLD: ProWorld = { accounts: PRO_ACCOUNTS, venueName: PRO_VENUE_NAME, slugPrefix: "pro-collective-night", audiencePrefix: "qa.scale." }

export async function ensureProPersonas(db: PrismaClient, password: string, world: ProWorld = PRO_WORLD): Promise<void> {
  const refusal = environmentRefusal(process.env)
  if (refusal) throw new Error(`REFUSING to write pro personas: ${refusal}`)
  for (const a of world.accounts) {
    const check = checkPassword(password, a.email)
    if (!check.ok) throw new Error(`SEED_PASSWORD refused for ${a.email}: ${check.message}`)
  }

  const people: Record<string, { userId: string; orgId: string }> = {}
  for (const account of world.accounts) {
    const org = await upsertOrg(db, account.orgName)
    const userId = await upsertAccount(db, account, password)
    await db.profiles.upsert({ where: { id: userId }, update: {}, create: { id: userId, name: account.name, age: 30 } })
    await db.organisation_members.upsert({
      where: { org_id_user_id: { org_id: org.id, user_id: userId } },
      update: { role: "owner" },
      create: { org_id: org.id, user_id: userId, role: "owner", is_primary_contact: true },
    })
    people[account.key] = { userId, orgId: org.id }
  }

  const venue = await ensureVenue(db, world.venueName, people.venuePro.orgId)
  const orgName = (key: string) => world.accounts.find((a) => a.key === key)?.orgName ?? key
  await ensureGrant(db, { kind: "org", id: people.organiserPro.orgId }, "analytics", "organisation", orgName("organiserPro"), people.organiserPro.orgId)
  await ensureGrant(db, { kind: "venue", id: venue.id }, "venue_pro", "venue", world.venueName, people.venuePro.orgId)
  const nights = await ensureHistory(db, people.organiserPro, venue.id, world)
  console.log(`  pro personas: analytics grant, venue pro grant, ${nights} ended night(s) of ${AUDIENCE} at ${world.venueName}`)
}

/**
 * Claimed by the pro venue organisation, in Bengaluru, and claimed BEFORE the
 * first night: a venue owner's reads start at `claimed_at`, so a claim dated
 * today would hide the history (`venues_owner_needs_claimed_at` wants a date).
 */
async function ensureVenue(db: PrismaClient, name: string, orgId: string) {
  const claimedAt = new Date(Date.now() - (NIGHTS_AGO[0] + 30) * DAY_MS)
  const existing = await db.venues.findFirst({ where: { name }, select: { id: true, claimed_at: true } })
  if (existing) {
    await db.venues.update({ where: { id: existing.id }, data: { owner_org_id: orgId, deleted_at: null, ...(!existing.claimed_at && { claimed_at: claimedAt }) } })
    return existing
  }
  return db.venues.create({
    data: {
      name,
      address: "100 Feet Road, Indiranagar, Bengaluru",
      city: "Bengaluru",
      latitude: 12.9784,
      longitude: 77.6408,
      capacity: 80,
      venue_type: "pub_bar",
      owner_org_id: orgId,
      claimed_at: claimedAt,
    },
    select: { id: true },
  })
}

/** A live admin-shaped grant (source grant, no reference) when there is none, audited as the admin. */
async function ensureGrant(
  db: PrismaClient,
  subject: { kind: "org" | "venue"; id: string },
  product: "analytics" | "venue_pro",
  resource: "organisation" | "venue",
  name: string,
  orgId: string
) {
  const now = new Date()
  const live = await db.entitlements.findFirst({
    where: {
      subject_kind: subject.kind,
      subject_id: subject.id,
      product,
      source: "grant",
      external_ref: null,
      starts_at: { lte: now },
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
    select: { id: true },
  })
  if (live) return
  const expiresAt = new Date(now)
  expiresAt.setMonth(expiresAt.getMonth() + GRANT_MONTHS)
  const admin = await db.user.findUnique({ where: { email: "admin@blendn.app" }, select: { id: true } })
  await db.$transaction(async (tx) => {
    await tx.entitlements.create({ data: { subject_kind: subject.kind, subject_id: subject.id, product, source: "grant", starts_at: now, expires_at: expiresAt } })
    await auditInTx(tx, {
      userId: admin?.id,
      action: "entitlement.granted",
      resource,
      resourceId: subject.id,
      orgId,
      details: { product, months: GRANT_MONTHS, expiresAt: expiresAt.toISOString(), reason: "Standing QA persona (scripts/seed-pro-personas.ts)", name },
    })
  })
}

/**
 * Three ended nights at the pro venue, by the pro organisation, with the same
 * dozen synthetic attendees each time so a returning share exists.
 *
 * Fixed once: an event keeps the start it was made with (a re-run neither moves
 * it nor makes new days), a night that already holds its dozen is left alone
 * (a newcomer sorting earlier cannot become a thirteenth), and the dozen are
 * `qa.scale.*` people, never a real tester.
 */
async function ensureHistory(db: PrismaClient, organiser: { userId: string; orgId: string }, venueId: string, world: ProWorld): Promise<number> {
  const audience = await db.user.findMany({
    where: { email: { startsWith: world.audiencePrefix }, role: "attendee", deletedAt: null, suspended_at: null, profile: { is: { onboarded: true } } },
    select: { id: true },
    orderBy: { email: "asc" },
    take: AUDIENCE,
  })
  if (audience.length < AUDIENCE) {
    console.log(`  !  only ${audience.length} ${world.audiencePrefix}* attendees to seed the pro history with (need ${AUDIENCE}) — run seed:qa-scale first`)
    return 0
  }
  let nights = 0
  for (const [i, daysAgo] of NIGHTS_AGO.entries()) {
    const slug = `${world.slugPrefix}-${i + 1}`
    const existing = await db.events.findUnique({ where: { slug }, select: { id: true, start_time: true, end_time: true, timezone: true } })
    const planned = new Date(Date.now() - daysAgo * DAY_MS)
    planned.setUTCHours(14, 0, 0, 0) // 19:30 IST
    const start = existing?.start_time ?? planned
    const end = existing?.end_time ?? new Date(start.getTime() + 3 * 3600_000)
    const event =
      existing ??
      (await db.events.create({
        data: {
          slug,
          title: `Pro Collective night ${i + 1}`,
          description: "A standing QA event: ended, with enough people for every figure to render.",
          start_time: start,
          end_time: end,
          timezone: "Asia/Kolkata",
          status: "published",
          visibility: "public",
          organizer_id: organiser.userId,
          organizer_org_id: organiser.orgId,
          venue_id: venueId,
          latitude: 12.9784,
          longitude: 77.6408,
        },
        select: { id: true, start_time: true, end_time: true, timezone: true },
      }))
    if (existing) await db.events.update({ where: { id: existing.id }, data: { organizer_org_id: organiser.orgId, venue_id: venueId, deleted_at: null } })
    await syncOccurrences(event.id, start, end, event.timezone)
    const occurrence = await db.event_occurrences.findFirst({ where: { event_id: event.id }, orderBy: { occurs_on: "asc" }, select: { id: true } })
    if (!occurrence) throw new Error(`no occurrence for ${slug}`)
    if ((await db.event_check_ins.count({ where: { occurrence_id: occurrence.id } })) < AUDIENCE) {
      for (const { id: userId } of audience) {
        await db.event_check_ins.upsert({
          where: { occurrence_id_user_id: { occurrence_id: occurrence.id, user_id: userId } },
          update: {},
          create: {
            event_id: event.id,
            occurrence_id: occurrence.id,
            user_id: userId,
            kind: "attendee",
            status: "checked_out",
            check_in_time: start,
            created_at: start,
            check_out_time: end,
          },
        })
      }
    }
    nights++
  }
  return nights
}
