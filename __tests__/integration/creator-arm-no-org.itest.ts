import { reportScope } from "@/lib/reports"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Who created an event is not who may read it (CLAUDE.md: organisation-shaped, not identity-shaped). The creator arm in
 * the list scope (`visibleEventsScope`) and the report scope (`reportScope`) — `organizer_id = me` — kept host reads of
 * org A's events for someone removed from A who still belongs to org B (SCRUM-942). It was then narrowed to events with
 * no organisation, the legacy rows from before organisations. Production is rebuilt from migrations and every non-admin
 * create writes an organisation (`owningOrgFor`), so the arm is gone: an org-less event is nobody's to list but an
 * admin's (SCRUM-1250).
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function makeOrg(label: string) {
  const org = await db.organisations.create({ data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" } })
  orgs.push(org.id)
  return org.id
}

const ids = async (where: object, among: string[]) =>
  (await db.events.findMany({ where: { AND: [where, { id: { in: among } }] }, select: { id: true } })).map((e) => e.id).sort()

describe("an organizer and the events they created", () => {
  let creator: string
  let orgA: string
  let ofA: string
  let noOrg: string

  beforeAll(async () => {
    creator = await makeUser(testId("arm-creator"), "organizer")
    users.push(creator)
    orgA = await makeOrg("arm-a")
    const orgB = await makeOrg("arm-b")
    await db.organisation_members.createMany({ data: [{ org_id: orgA, user_id: creator, role: "owner" }, { org_id: orgB, user_id: creator, role: "owner" }] })
    ofA = await makeEvent(creator)
    noOrg = await makeEvent(creator)
    events.push(ofA, noOrg)
    await db.events.update({ where: { id: ofA }, data: { organizer_org_id: orgA } })
  })

  const listed = async () => ids(await visibleEventsWhere({ id: creator, role: "organizer" }), [ofA, noOrg])
  const hosted = async () => ids((await reportScope("organizer", creator)).hosted, [ofA, noOrg])

  it("sees A's event while a member of A (negative control: the scope is not simply empty)", async () => {
    expect(await listed()).toEqual([ofA])
    expect(await hosted()).toEqual([ofA])
  })

  it("never sees the event with no organisation, though they created it", async () => {
    expect(await listed()).not.toContain(noOrg)
    expect(await hosted()).not.toContain(noOrg)
  })

  it("after leaving A, sees neither, in lists or in reports", async () => {
    await db.organisation_members.deleteMany({ where: { org_id: orgA, user_id: creator } })
    expect(await listed()).toEqual([])
    expect(await hosted()).toEqual([])
  })
})

it("lists nothing to an organizer in no organisation, not even their own event (an empty `OR` would be no filter at all)", async () => {
  const lonely = await makeUser(testId("arm-lonely"), "organizer")
  users.push(lonely)
  const own = await makeEvent(lonely)
  events.push(own)
  expect(await ids(await visibleEventsWhere({ id: lonely, role: "organizer" }), [own])).toEqual([])
})

it("puts an event at our venue that we created but another org runs in venueOnly, not hosted: hosted and venueOnly partition all", async () => {
  const viewer = await makeUser(testId("arm-venue"), "organizer")
  users.push(viewer)
  const venueOrg = await makeOrg("arm-venue-org")
  const hostOrg = await makeOrg("arm-host-org")
  await db.organisation_members.create({ data: { org_id: venueOrg, user_id: viewer, role: "owner" } })
  const venue = await db.venues.create({
    data: { name: testId("arm-venue"), city: "Bengaluru", latitude: 12.97, longitude: 77.59, owner_org_id: venueOrg, claimed_at: new Date(Date.now() - 30 * 86_400_000) },
  })
  venues.push(venue.id)
  const created = await makeEvent(viewer)
  events.push(created)
  await db.events.update({ where: { id: created }, data: { organizer_org_id: hostOrg, venue_id: venue.id } })

  const scope = await reportScope("organizer", viewer)
  expect(await ids(scope.all, [created])).toEqual([created])
  expect(await ids(scope.hosted, [created])).toEqual([])
  expect(await ids(scope.venueOnly, [created])).toEqual([created])
})
