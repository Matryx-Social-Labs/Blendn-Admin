import { eventPermissions, eventPermissionSelect } from "@/lib/rbac"
import { actorFor } from "@/lib/org-membership"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/**
 * The unit matrix in __tests__/event-permissions.test.ts proves the resolver's
 * logic. It cannot prove the thing that actually broke in production: that the
 * *query feeding it* loads the venue.
 *
 * `PermissionEvent.venue` is optional-shaped at the database level — a `select`
 * that forgets it yields `undefined`, the resolver reads that as "no linked
 * venue", and a venue owner is denied access to their own building without any
 * error anywhere. TypeScript catches a missing key; it cannot catch a `select`
 * that fetches the relation as null when a row exists.
 *
 * So these run the real query shape against real rows.
 */

const users: string[] = []
const events: string[] = []
const venues: string[] = []
const orgs: string[] = []

/** Create an org with one member, mirroring what onboarding will do. */
async function makeOrg(ownerId: string, kind: "individual" | "company" = "individual") {
  const org = await db.organisations.create({
    data: { kind, display_name: testId("org"), status: "verified" },
  })
  orgs.push(org.id)
  await db.organisation_members.create({
    data: { org_id: org.id, user_id: ownerId, role: "owner", is_primary_contact: true },
  })
  return org.id
}

afterAll(async () => {
  if (events.length) await db.events.deleteMany({ where: { id: { in: events } } })
  if (venues.length) await db.venues.deleteMany({ where: { id: { in: venues } } })
  if (orgs.length) await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function makeVenue(ownerOrgId: string | null) {
  const venue = await db.venues.create({
    data: {
      name: testId("venue"),
      city: "Bangalore",
      owner_org_id: ownerOrgId,
      claimed_at: ownerOrgId ? new Date() : null,
    },
  })
  venues.push(venue.id)
  return venue.id
}

async function makeEventAt(organizerId: string, venueId: string | null, orgId?: string) {
  const slug = testId("perm")
  const start = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
  const event = await db.events.create({
    data: {
      slug,
      title: `Perm ${slug}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
      status: "published",
      organizer_id: organizerId,
      organizer_org_id: orgId ?? null,
      venue_id: venueId,
      venue_link_status: venueId ? "auto_linked" : null,
    },
  })
  events.push(event.id)
  return event.id
}

/** Exactly what a route does: fetch with the shared select, then resolve. */
async function resolve(actorId: string, role: "app_admin" | "organizer" | "venue_owner", eventId: string) {
  const event = await db.events.findUniqueOrThrow({
    where: { id: eventId },
    select: eventPermissionSelect,
  })
  // Memberships loaded exactly as a route does, so a mismatch between the
  // helper's query and the resolver's expectation shows up here.
  return eventPermissions(await actorFor({ id: actorId, role }), event)
}

describe("the venue-owner dead end, against real rows", () => {
  it("gives a venue owner operational access to someone else's event at their venue", async () => {
    // This is the case that was broken in production: the nav showed Chatrooms,
    // the list showed the room, and opening it redirected straight back out.
    const owner = await makeUser("perm_venue_owner", "organizer")
    const organiser = await makeUser("perm_organiser", "organizer")
    users.push(owner, organiser)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    const venueOrg = await makeOrg(owner, "company")
    const hostOrg = await makeOrg(organiser)
    const venueId = await makeVenue(venueOrg)
    const eventId = await makeEventAt(organiser, venueId, hostOrg)

    const p = await resolve(owner, "venue_owner", eventId)
    expect(p.canOperate).toBe(true)
    expect(p.canEdit).toBe(false)
  })

  it("gives that same venue owner nothing on an event elsewhere", async () => {
    const owner = await makeUser("perm_owner2", "organizer")
    const organiser = await makeUser("perm_org2", "organizer")
    users.push(owner, organiser)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    await makeVenue(await makeOrg(owner, "company"))
    const elsewhere = await makeEventAt(organiser, null, await makeOrg(organiser))

    const p = await resolve(owner, "venue_owner", elsewhere)
    expect(p.canOperate).toBe(false)
    expect(p.canEdit).toBe(false)
  })

  it("gives a venue owner both buckets on an event they run themselves", async () => {
    const owner = await makeUser("perm_owner3", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    const ownOrg = await makeOrg(owner, "company")
    const venueId = await makeVenue(ownOrg)
    const eventId = await makeEventAt(owner, venueId, ownOrg)

    const p = await resolve(owner, "venue_owner", eventId)
    expect(p.canEdit).toBe(true)
    expect(p.canOperate).toBe(true)
  })
})

describe("unclaimed venues grant nothing", () => {
  it("denies a venue owner on an event at a venue nobody owns", async () => {
    // A venue record created by an admin and never claimed. owner_id is null,
    // and null must never match an actor.
    const owner = await makeUser("perm_owner4", "organizer")
    const organiser = await makeUser("perm_org4", "organizer")
    users.push(owner, organiser)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    await makeOrg(owner, "company")
    const unclaimed = await makeVenue(null)
    const eventId = await makeEventAt(organiser, unclaimed, await makeOrg(organiser))

    const p = await resolve(owner, "venue_owner", eventId)
    expect(p.canOperate).toBe(false)
  })
})

describe("the shared select loads what the resolver needs", () => {
  it("returns a venue object, not undefined, when the event is linked", async () => {
    // The regression guard. A route that hand-rolls its select and omits the
    // venue relation gets `undefined` here and silently denies venue owners.
    const owner = await makeUser("perm_owner5", "organizer")
    users.push(owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    const ownOrg = await makeOrg(owner, "company")
    const venueId = await makeVenue(ownOrg)
    const eventId = await makeEventAt(owner, venueId, ownOrg)

    const event = await db.events.findUniqueOrThrow({
      where: { id: eventId },
      select: eventPermissionSelect,
    })
    expect(event.venue).not.toBeUndefined()
    expect(event.venue?.owner_org_id).not.toBeNull()
  })

  it("returns null venue for an unlinked event, which is the common case", async () => {
    const organiser = await makeUser("perm_org6", "organizer")
    users.push(organiser)
    const eventId = await makeEventAt(organiser, null)

    const event = await db.events.findUniqueOrThrow({
      where: { id: eventId },
      select: eventPermissionSelect,
    })
    expect(event.venue).toBeNull()
  })
})

describe("admin is unaffected by venue linkage", () => {
  it("grants both buckets whether or not a venue is linked", async () => {
    const admin = await makeUser("perm_admin", "app_admin")
    const organiser = await makeUser("perm_org7", "organizer")
    users.push(admin, organiser)

    const hostOrg = await makeOrg(organiser)
    const linked = await makeEventAt(organiser, await makeVenue(null), hostOrg)
    const unlinked = await makeEventAt(organiser, null, hostOrg)

    for (const eventId of [linked, unlinked]) {
      const p = await resolve(admin, "app_admin", eventId)
      expect(p.canEdit).toBe(true)
      expect(p.canOperate).toBe(true)
    }
  })
})
