import { attendeeRoster } from "@/lib/attendee-roster"
import { attendeeLabel } from "@/lib/pseudonym"
import { buildReport } from "@/lib/reports"
import { labelScoper } from "@/lib/reports"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * SCRUM-889: a night to which fewer than five came lists nobody — not on the
 * organisation's roster, not in the Attendees export. At one, the single label
 * is the single room pseudonym, and from there that person's history across
 * the organisation's nights. A night with five or more still does.
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function night(orgId: string, host: string, daysAgo: number, came: string[], rsvp: string[] = []) {
  const start = new Date(Date.now() - daysAgo * DAY)
  const event = await db.events.create({
    data: { slug: testId("snh"), title: `Night ${daysAgo}`, description: "fixture", start_time: start, end_time: new Date(start.getTime() + 2 * HOUR), timezone: "UTC", status: "published", organizer_id: host, organizer_org_id: orgId },
  })
  events.push(event.id)
  const occ = await db.event_occurrences.create({ data: { event_id: event.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: event.end_time } })
  for (const user_id of came) {
    await db.event_check_ins.create({ data: { event_id: event.id, occurrence_id: occ.id, user_id, kind: "attendee", status: "checked_out", check_in_time: new Date(start.getTime() + HOUR) } })
  }
  for (const user_id of rsvp) await db.event_rsvps.create({ data: { event_id: event.id, user_id, status: "going" } })
  return event.id
}

let host = ""
let solo = ""
let early = ""
let crowd: string[] = []
let lates: string[] = []
let label: (userId: string) => string

beforeAll(async () => {
  host = await makeUser(testId("snh-host"), "organizer")
  solo = await makeUser(testId("snh-solo"))
  crowd = await Promise.all([1, 2, 3, 4, 5].map((n) => makeUser(testId(`snh-c${n}`))))
  early = await makeUser(testId("snh-early"))
  lates = await Promise.all([1, 2, 3, 4].map((n) => makeUser(testId(`snh-late${n}`))))
  users.push(host, solo, early, ...lates, ...crowd)
  const org = await db.organisations.create({ data: { display_name: `Org ${testId("snh")}`, kind: "company", status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  // One came alone and one who RSVP'd did not; five came to the other night.
  await night(org.id, host, 4, [solo], [crowd[0]])
  await night(org.id, host, 2, crowd)
  /*
   * One on time and four after the night settled: five came in all, but the list
   * only shows who came by the settle, so it would list the one label alone.
   */
  const lateNight = await night(org.id, host, 6, [])
  const settle = new Date(Date.now() - 6 * DAY + 3 * HOUR)
  await db.events.update({ where: { id: lateNight }, data: { host_settled_at: settle } })
  const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: lateNight } })
  for (const [i, user_id] of [early, ...lates].entries()) {
    const at = new Date(settle.getTime() + (i === 0 ? -HOUR : HOUR))
    await db.event_check_ins.create({ data: { event_id: lateNight, occurrence_id: occ.id, user_id, kind: "attendee", status: "checked_out", check_in_time: at, created_at: at } })
  }
  const scope = await labelScoper("organizer", host)
  label = (userId) => attendeeLabel(userId, scope(org.id))
})

afterAll(async () => {
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

describe("a night under five", () => {
  it("is not on the organisation's roster: not who came, and not who failed to", async () => {
    const roster = await attendeeRoster("organizer", host)
    const ids = roster.rows.map((r) => r.id)
    expect(ids).not.toContain(label(solo))
    // Five came in all, one by the settle: held by what the list could show, not by the late total.
    expect(ids).not.toContain(label(early))
    // The one who RSVP'd to the small night is not turned into a no-show by its being held back.
    expect(roster.rows.find((r) => r.id === label(crowd[0]))).toMatchObject({ attended: 1, noShows: 0 })
    expect(ids.sort()).toEqual(crowd.map(label).sort())
  })

  it("is not in the Attendees export, while the night of five is", async () => {
    const csv = await buildReport("attendees", "organizer", host, { key: "custom", from: new Date(Date.now() - 10 * DAY), to: new Date(Date.now() + HOUR) })
    expect(csv).not.toContain(label(solo))
    expect(csv).not.toContain(label(early))
    for (const c of crowd) expect(csv).toContain(label(c))
  })
})
