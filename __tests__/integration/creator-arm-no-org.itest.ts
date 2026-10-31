import { reportScope } from "@/lib/reports"
import { visibleEventsWhere } from "@/lib/event-visibility"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * Who created an event is not who may read it (CLAUDE.md: organisation-shaped, not identity-shaped). The creator arm in
 * the list scope (`visibleEventsScope`) and the report scope (`reportScope`) — `organizer_id = me` — kept host reads of
 * org A's events for someone removed from A who still belongs to org B: titles in lists and search, per-guest rosters,
 * exports and analytics (SCRUM-942). It now holds only for an event with no organisation, the legacy rows it was kept
 * for (owner row A-16, decided by lean on 2026-10-31; reverse if wanted). Staging held 85 such events that day.
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function makeOrg(label: string) {
  const org = await db.organisations.create({ data: { display_name: `Org ${testId(label)}`, kind: "company", status: "verified" } })
  orgs.push(org.id)
  return org.id
}

describe("an organizer who left the org their events belong to", () => {
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

  const listed = async () =>
    (await db.events.findMany({ where: { AND: [await visibleEventsWhere({ id: creator, role: "organizer" }), { id: { in: [ofA, noOrg] } }] }, select: { id: true } })).map((e) => e.id).sort()
  const hosted = async () =>
    (await db.events.findMany({ where: { AND: [(await reportScope("organizer", creator)).hosted, { id: { in: [ofA, noOrg] } }] }, select: { id: true } })).map((e) => e.id).sort()

  it("sees both while a member of A (negative control)", async () => {
    expect(await listed()).toEqual([ofA, noOrg].sort())
    expect(await hosted()).toEqual([ofA, noOrg].sort())
  })

  it("after leaving A, keeps only the event with no organisation, in lists and in reports", async () => {
    await db.organisation_members.deleteMany({ where: { org_id: orgA, user_id: creator } })
    expect(await listed()).toEqual([noOrg])
    expect(await hosted()).toEqual([noOrg])
  })
})
