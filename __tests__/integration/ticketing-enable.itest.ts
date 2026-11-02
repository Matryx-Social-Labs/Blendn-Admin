import { createHash } from "node:crypto"

import { ORGANIZER_TICKETING_TERMS } from "@/lib/legal-acceptance"
import { enableTicketing } from "@/lib/ticketing-enable"
import { FOUNDING_OFFER_EVENTS, parseFeeSchedule } from "@/lib/ticket-fees"

import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Turning ticketing on (SCRUM-1010, security H4): the one writer of an event's
 * price rule and fee snapshot, decided from the database and never from a
 * request. Organisation-shaped, like every other event permission.
 *
 * Organisations and their acceptances are left behind: `legal_acceptances`
 * is append-only and RESTRICTs its organisation. Every name is a `testId`.
 */

const users: string[] = []
const events: string[] = []
const SHOWN = createHash("sha256").update("terms").digest("hex")

let previousFlag: string | undefined
beforeAll(() => {
  previousFlag = process.env.TICKETING
  process.env.TICKETING = "true"
})
afterAll(async () => {
  process.env.TICKETING = previousFlag
  await db.audit_logs.deleteMany({ where: { action: "ticketing.enable", resource_id: { in: events } } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: [...orgs, ...venues] } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

const orgs: string[] = []
const venues: string[] = []

async function org(opts: { accepted?: string | null } = {}) {
  const row = await db.organisations.create({ data: { display_name: testId("te-org"), kind: "company", status: "verified" }, select: { id: true } })
  orgs.push(row.id)
  const owner = await member(row.id, "owner")
  const accepted = opts.accepted === undefined ? ORGANIZER_TICKETING_TERMS.version : opts.accepted
  if (accepted) {
    await db.legal_acceptances.create({
      data: { org_id: row.id, user_id: owner, document_key: ORGANIZER_TICKETING_TERMS.key, version: accepted, document_sha256: SHOWN },
    })
  }
  return { orgId: row.id, owner }
}

async function member(orgId: string, role: "owner" | "admin" | "staff", userRole: "organizer" | "attendee" = "organizer") {
  const id = await makeUser(testId("te-member"), userRole)
  // An owner signs the terms, and an acceptance RESTRICTs its user: owners stay, as orgs do.
  if (role !== "owner") users.push(id)
  await db.organisation_members.create({ data: { org_id: orgId, user_id: id, role } })
  return id
}

async function eventOf(orgId: string, host: string, city = "Bengaluru") {
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({ where: { id }, data: { organizer_org_id: orgId, city } })
  return id
}

const asOrganizer = (id: string) => ({ id, role: "organizer" as const })

describe("turning ticketing on", () => {
  it("snapshots the city's market, derives the rule, records when, and audits it", async () => {
    const { orgId, owner } = await org()
    const eventId = await eventOf(orgId, owner)

    const result = await enableTicketing(eventId, asOrganizer(owner))

    if (!result.ok) throw new Error(`refused: ${result.reason}`)
    const row = await db.events.findUniqueOrThrow({ where: { id: eventId } })
    expect(row).toMatchObject({ ticketing_mode: "native", ticket_fee_rule: "founding", ticketing_enabled_at: result.enabledAt })
    expect(parseFeeSchedule(row.ticket_fee_schedule)).toMatchObject({
      market: "IN",
      currency: "INR",
      slabs: [{ fromTicket: 1, bps: 500 }, { fromTicket: 101, bps: 350 }, { fromTicket: 501, bps: 200 }],
      minFeeMinor: 1_000,
      serviceTaxBps: 1_800,
      processingBps: 236,
    })
    expect(await db.audit_logs.findFirst({ where: { action: "ticketing.enable", resource_id: eventId } })).toMatchObject({ user_id: owner, org_id: orgId })
  })

  it("a colleague who did not create the event may: access is the organisation's", async () => {
    const { orgId, owner } = await org()
    const colleague = await member(orgId, "staff")
    const eventId = await eventOf(orgId, owner)
    expect((await enableTicketing(eventId, asOrganizer(colleague))).ok).toBe(true)
  })

  it("the founding offer is the first three events; the fourth is standard", async () => {
    const { orgId, owner } = await org()
    const rules = []
    for (let i = 0; i <= FOUNDING_OFFER_EVENTS; i++) {
      const r = await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))
      rules.push(r.ok ? r.rule : r.reason)
    }
    expect(rules).toEqual(["founding", "founding", "founding", "standard"])
  })

  it("two events turned on at once cannot both be the third", async () => {
    const { orgId, owner } = await org()
    for (let i = 0; i < FOUNDING_OFFER_EVENTS - 1; i++) await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))
    const [a, b] = [await eventOf(orgId, owner), await eventOf(orgId, owner)]

    const results = await Promise.all([enableTicketing(a, asOrganizer(owner)), enableTicketing(b, asOrganizer(owner))])

    expect(results.map((r) => (r.ok ? r.rule : r.reason)).sort()).toEqual(["founding", "standard"])
  })

  it("Pro, from the organisation's paid Analytics, once the founding offer is spent", async () => {
    const { orgId, owner } = await org()
    for (let i = 0; i < FOUNDING_OFFER_EVENTS; i++) await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))
    await db.entitlements.create({
      data: { subject_kind: "org", subject_id: orgId, product: "analytics", source: "razorpay", starts_at: new Date(Date.now() - 60_000), external_ref: testId("sub") },
    })

    const result = await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))

    expect(result.ok && result.rule).toBe("pro")
  })

  it("Pro, from Venue Pro on the event's venue when the organisation owns it — and not when another organisation does", async () => {
    const { orgId, owner } = await org()
    const other = await org()
    for (let i = 0; i < FOUNDING_OFFER_EVENTS; i++) await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))
    const venueFor = async (ownerOrg: string) => {
      const v = await db.venues.create({
        data: { name: testId("te-venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.6, owner_org_id: ownerOrg, claimed_at: new Date(Date.now() - 86_400_000) },
        select: { id: true },
      })
      venues.push(v.id)
      await db.entitlements.create({
        data: { subject_kind: "venue", subject_id: v.id, product: "venue_pro", source: "razorpay", starts_at: new Date(Date.now() - 60_000), external_ref: testId("vp") },
      })
      return v.id
    }
    const ours = await eventOf(orgId, owner)
    const theirs = await eventOf(orgId, owner)
    await db.events.update({ where: { id: ours }, data: { venue_id: await venueFor(orgId) } })
    await db.events.update({ where: { id: theirs }, data: { venue_id: await venueFor(other.orgId) } })

    expect(await enableTicketing(ours, asOrganizer(owner))).toMatchObject({ ok: true, rule: "pro" })
    expect(await enableTicketing(theirs, asOrganizer(owner))).toMatchObject({ ok: true, rule: "standard" })
  })
})

describe("who may not", () => {
  it("an organizer of another organisation", async () => {
    const mine = await org()
    const theirs = await org()
    const eventId = await eventOf(mine.orgId, mine.owner)
    expect(await enableTicketing(eventId, asOrganizer(theirs.owner))).toEqual({ ok: false, reason: "not_authorized" })
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).ticketing_mode).toBe("off")
  })

  it("someone claiming a role the database does not give them", async () => {
    const { orgId, owner } = await org()
    const eventId = await eventOf(orgId, owner)
    const attendee = await makeUser(testId("te-attendee"))
    users.push(attendee)
    expect(await enableTicketing(eventId, { id: attendee, role: "app_admin" })).toEqual({ ok: false, reason: "not_authorized" })
  })

  it("an event no organisation runs, even for an admin: there is nobody to pay", async () => {
    const { orgId, owner } = await org()
    const eventId = await eventOf(orgId, owner)
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: null } })
    const admin = await makeUser(testId("te-admin"), "app_admin")
    users.push(admin)
    expect(await enableTicketing(eventId, { id: admin, role: "app_admin" })).toEqual({ ok: false, reason: "no_organization" })
  })

  it("while TICKETING is off", async () => {
    const { orgId, owner } = await org()
    const eventId = await eventOf(orgId, owner)
    process.env.TICKETING = "false"
    try {
      expect(await enableTicketing(eventId, asOrganizer(owner))).toEqual({ ok: false, reason: "ticketing_off" })
    } finally {
      process.env.TICKETING = "true"
    }
  })
})

describe("what must be true first", () => {
  it("the organisation accepted the terms (database 13)", async () => {
    const { orgId, owner } = await org({ accepted: null })
    expect(await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))).toEqual({ ok: false, reason: "terms_not_accepted" })
  })

  it("the version of the terms in force, not an older one", async () => {
    const { orgId, owner } = await org({ accepted: "0.0" })
    expect(await enableTicketing(await eventOf(orgId, owner), asOrganizer(owner))).toEqual({ ok: false, reason: "terms_not_accepted" })
  })

  it("a market that sells natively: a Toronto event is not", async () => {
    const { orgId, owner } = await org()
    expect(await enableTicketing(await eventOf(orgId, owner, "Toronto"), asOrganizer(owner))).toEqual({ ok: false, reason: "market_not_native" })
  })

  it("a city we know", async () => {
    const { orgId, owner } = await org()
    expect(await enableTicketing(await eventOf(orgId, owner, "Atlantis"), asOrganizer(owner))).toEqual({ ok: false, reason: "market_not_native" })
  })

  it("not already on: the price, once decided, stays decided", async () => {
    const { orgId, owner } = await org()
    const eventId = await eventOf(orgId, owner)
    const first = await enableTicketing(eventId, asOrganizer(owner))
    expect(await enableTicketing(eventId, asOrganizer(owner))).toEqual({ ok: false, reason: "already_enabled" })
    expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).ticketing_enabled_at).toEqual(first.ok && first.enabledAt)
  })
})
