import { ensureProPersonas, PRO_ACCOUNTS, type ProWorld } from "@/scripts/seed-pro-personas"

import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/*
 * SCRUM-561: organizer.pro@ and venue.pro@ — standing paid personas — against a
 * real database, in a namespaced world (the real addresses would be the
 * developer's own fixture). Idempotent, a grant and not a payment, and the
 * free organiser untouched.
 */

const PASSWORD = "correct-horse-battery-2026"
const tag = testId("pro")
const userIds: string[] = []
const world: ProWorld = {
  accounts: PRO_ACCOUNTS.map((a) => ({ ...a, email: `${tag}-${a.key}@itest.invalid`, orgName: `${tag} ${a.orgName}` })),
  venueName: `${tag} venue`,
  slugPrefix: `${tag}-night`,
  audiencePrefix: `${tag}-aud-`,
}
const NIGHT_SLUGS = [1, 2, 3].map((n) => `${world.slugPrefix}-${n}`)

async function ids() {
  const email = (key: string) => world.accounts.find((a) => a.key === key)!.email
  const org = await db.organisations.findFirstOrThrow({ where: { display_name: world.accounts.find((a) => a.key === "organiserPro")!.orgName } })
  const venueOrg = await db.organisations.findFirstOrThrow({ where: { display_name: world.accounts.find((a) => a.key === "venuePro")!.orgName } })
  const venue = await db.venues.findFirstOrThrow({ where: { name: world.venueName } })
  return { org, venueOrg, venue, organiser: await db.user.findUniqueOrThrow({ where: { email: email("organiserPro") } }) }
}

beforeAll(async () => {
  // Twelve onboarded attendees to be the audience, found by the world's prefix.
  for (let i = 0; i < 12; i++) {
    const id = await makeUser(testId(`pro-att-${i}`))
    userIds.push(id)
    await onboard(id)
    await db.user.update({ where: { id }, data: { email: `${tag}-aud-${String(i).padStart(2, "0")}@itest.invalid` } })
  }
})

afterAll(async () => {
  const events = await db.events.findMany({ where: { slug: { in: NIGHT_SLUGS } }, select: { id: true } })
  const orgs = await db.organisations.findMany({ where: { display_name: { startsWith: tag } }, select: { id: true } })
  const venues = await db.venues.findMany({ where: { name: { startsWith: tag } }, select: { id: true } })
  const people = await db.user.findMany({ where: { email: { startsWith: tag } }, select: { id: true } })
  await db.entitlements.deleteMany({ where: { subject_id: { in: [...orgs.map((o) => o.id), ...venues.map((v) => v.id)] } } })
  await db.audit_logs.deleteMany({ where: { org_id: { in: orgs.map((o) => o.id) } } })
  await cleanup([...userIds, ...people.map((p) => p.id)], events.map((e) => e.id))
  await db.venues.deleteMany({ where: { id: { in: venues.map((v) => v.id) } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs.map((o) => o.id) } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs.map((o) => o.id) } } })
  await closeDb()
})

describe("the pro personas", () => {
  it("make two owners, a claimed venue, a grant each and no payment", async () => {
    await ensureProPersonas(db as never, PASSWORD, world)
    const { org, venueOrg, venue } = await ids()

    const members = await db.organisation_members.findMany({ where: { org_id: { in: [org.id, venueOrg.id] } } })
    expect(members.map((m) => m.role)).toEqual(["owner", "owner"])
    expect(org.status).toBe("verified")
    expect(venue.owner_org_id).toBe(venueOrg.id)
    expect(venue.claimed_at).not.toBeNull()

    const rows = await db.entitlements.findMany({ where: { subject_id: { in: [org.id, venue.id] } } })
    expect(rows.map((r) => `${r.subject_kind}:${r.product}:${r.source}:${r.external_ref}`).sort()).toEqual(["org:analytics:grant:null", "venue:venue_pro:grant:null"])
    expect(rows.every((r) => r.expires_at && r.expires_at.getTime() > Date.now())).toBe(true)
    expect(await db.audit_logs.count({ where: { action: "entitlement.granted", org_id: { in: [org.id, venueOrg.id] } } })).toBe(2)
  })

  it("give the organisation ended nights above the floor, the same people each time", async () => {
    const { org, venue } = await ids()
    const events = await db.events.findMany({ where: { slug: { in: NIGHT_SLUGS } }, include: { _count: { select: { check_ins: true } } } })
    expect(events).toHaveLength(3)
    expect(events.every((e) => e.organizer_org_id === org.id && e.venue_id === venue.id && e.end_time < new Date())).toBe(true)
    // The venue was claimed before its first night, so the owner's reads (which start at the claim) see the history.
    expect(venue.claimed_at!.getTime()).toBeLessThan(Math.min(...events.map((e) => e.start_time.getTime())))
    expect(events.map((e) => e._count.check_ins)).toEqual([12, 12, 12])
    expect((await db.event_check_ins.findMany({ where: { event_id: { in: events.map((e) => e.id) } }, distinct: ["user_id"] }))).toHaveLength(12)
  })

  it("change nothing on a second run: one live grant each, the same rows", async () => {
    const { org, venue } = await ids()
    const before = await db.entitlements.count({ where: { subject_id: { in: [org.id, venue.id] } } })
    const checkIns = await db.event_check_ins.count({ where: { event: { slug: { in: NIGHT_SLUGS } } } })
    await ensureProPersonas(db as never, PASSWORD, world)
    expect(await db.entitlements.count({ where: { subject_id: { in: [org.id, venue.id] } } })).toBe(before)
    expect(await db.event_check_ins.count({ where: { event: { slug: { in: NIGHT_SLUGS } } } })).toBe(checkIns)
    expect(await db.audit_logs.count({ where: { action: "entitlement.granted", org_id: { not: null }, resource_id: { in: [org.id, venue.id] } } })).toBe(2)
  })

  it("give a fresh grant when an admin ended the live one", async () => {
    const { org } = await ids()
    await db.entitlements.updateMany({ where: { subject_id: org.id }, data: { starts_at: new Date(Date.now() - 2000), expires_at: new Date(Date.now() - 1000) } })
    await ensureProPersonas(db as never, PASSWORD, world)
    const live = await db.entitlements.count({ where: { subject_id: org.id, expires_at: { gt: new Date() } } })
    expect(live).toBe(1)
  })

  it("refuse a password the product would refuse, before writing anything", async () => {
    const other: ProWorld = { ...world, venueName: `${tag} never` }
    await expect(ensureProPersonas(db as never, "short", other)).rejects.toThrow(/SEED_PASSWORD refused/)
    expect(await db.venues.count({ where: { name: other.venueName } })).toBe(0)
  })
})
