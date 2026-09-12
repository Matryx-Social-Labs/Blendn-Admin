import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { getDashboardOverview } from "@/app/dashboard/actions"
import { db, cleanup, closeDb, makeUser, testId } from "./helpers"

/*
 * The two overviews and the rooms list scope on organisation membership,
 * through `visibleEventsWhere`. The existing overview itest creates every
 * fixture event as the same user who then reads the overview, so it only ever
 * exercises the `organizer_id` fallback — the exact regression class (H2)
 * this scope was introduced to end could return and every test stay green.
 *
 * Two people who never created anything: a colleague at the organising org,
 * and the owner of the building. Both must see the event.
 */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

const DAY = 24 * 60 * 60 * 1000

async function makeOrg(label: string) {
  const org = await db.organisations.create({
    data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" },
  })
  orgs.push(org.id)
  return org.id
}

afterAll(async () => {
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("organisation-shaped overviews", () => {
  let creator: string
  let colleague: string
  let owner: string
  let eventId: string
  let venueId: string

  beforeAll(async () => {
    creator = await makeUser("creator", "organizer")
    colleague = await makeUser("colleague", "organizer")
    owner = await makeUser("owner", "organizer") // role fixed below; makeUser only knows three roles
    users.push(creator, colleague, owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

    const organiserOrg = await makeOrg("host")
    const buildingOrg = await makeOrg("building")
    await db.organisation_members.createMany({
      data: [
        { org_id: organiserOrg, user_id: creator, role: "owner" },
        { org_id: organiserOrg, user_id: colleague, role: "staff" },
        { org_id: buildingOrg, user_id: owner, role: "owner" },
      ],
    })

    const venue = await db.venues.create({
      data: { name: `Venue ${testId("v")}`, owner_org_id: buildingOrg, claimed_at: new Date() },
    })
    venueId = venue.id
    venues.push(venueId)

    const start = new Date(Date.now() + 3 * DAY)
    const event = await db.events.create({
      data: {
        slug: testId("orgscope"),
        title: "Colleague's night",
        description: "integration fixture",
        start_time: start,
        end_time: new Date(start.getTime() + 2 * 60 * 60 * 1000),
        timezone: "UTC",
        status: "published",
        organizer_id: creator,
        organizer_org_id: organiserOrg,
        venue_id: venueId,
        venue_name: venue.name,
      },
    })
    eventId = event.id
    events.push(eventId)
    await db.event_occurrences.create({
      data: {
        event_id: eventId,
        occurs_on: new Date(start.toISOString().slice(0, 10)),
        start_time: start,
        end_time: event.end_time,
      },
    })
  })

  it("a colleague who created nothing sees the org's event on the organiser overview", async () => {
    as("organizer", colleague)
    const overview = await getDashboardOverview()
    expect(overview.role).toBe("organizer")
    if (overview.role !== "organizer") return
    expect(overview.events.map((e) => e.id)).toContain(eventId)
    expect(overview.nextEvent?.id).toBe(eventId)
  })

  it("the venue owner sees an event at their building that another org runs", async () => {
    as("venue_owner", owner)
    const overview = await getDashboardOverview()
    expect(overview.role).toBe("venue_owner")
    if (overview.role !== "venue_owner") return
    const row = overview.venues.find((v) => v.nextBooking?.id === eventId)
    expect(row).toBeDefined()
  })

  it("an organiser outside both orgs sees neither", async () => {
    const stranger = await makeUser("stranger", "organizer")
    users.push(stranger)
    as("organizer", stranger)
    const overview = await getDashboardOverview()
    if (overview.role !== "organizer") throw new Error("expected organiser overview")
    expect(overview.events.map((e) => e.id)).not.toContain(eventId)
  })
})
