import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session ? { ...session, user: { signedInAt: Date.now(), ...session.user } } : null) }))

import { getDashboardOverview } from "@/app/dashboard/actions"
import { signupCohorts } from "@/lib/loop-closure"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

/**
 * Sign-ups by week (SCRUM-1281): RSVP'd within 7 days, checked in within 14,
 * a second distinct event within 30, per ISO week in India's calendar, and the
 * same stages by acquisition source.
 *
 * `loopClosure` cannot express any of this — it has no dates, and its "came
 * back" has no time bound — which is why the function is new.
 *
 * The clock is pinned to Monday 20 Apr 2020, 12:00 IST, so the eight weeks
 * (2 Mar … 20 Apr 2020) hold only this fixture's people on a shared database.
 */
const NOW = new Date("2020-04-20T12:00:00+05:30")
const DAY = 24 * 60 * 60 * 1000
const ist = (local: string) => new Date(`${local}:00+05:30`)
const after = (from: Date, days: number) => new Date(from.getTime() + days * DAY)

const users: string[] = []
const events: string[] = []
const venues: string[] = []

const hostOrgs: string[] = []

afterAll(async () => {
  await db.organisation_members.deleteMany({ where: { org_id: { in: hostOrgs } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { org_id: { in: hostOrgs } } })
  await db.organisations.deleteMany({ where: { id: { in: hostOrgs } } })
  await db.event_rsvps.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await closeDb()
})

async function person(label: string, joined: Date, source: string | null = null) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.user.update({ where: { id }, data: { createdAt: joined } })
  await db.profiles.create({ data: { id, onboarded: true, signup_source: source } })
  return id
}

async function night(data: Record<string, unknown> = {}) {
  const host = await makeUser(testId("sc-host"), "organizer")
  users.push(host)
  // Hosts are people too: pinned outside the eight weeks so they never join a cohort.
  await db.user.update({ where: { id: host }, data: { createdAt: new Date("2019-01-01T00:00:00Z") } })
  const eventId = await makeEvent(host)
  events.push(eventId)
  if (Object.keys(data).length) await db.events.update({ where: { id: eventId }, data })
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

const came = (n: { eventId: string; occurrenceId: string }, userId: string, at: Date) =>
  putInRoom({ eventId: n.eventId, occurrenceId: n.occurrenceId, userId, at, lastSeen: at })

const rsvp = (eventId: string, userId: string, at: Date) =>
  db.event_rsvps.create({ data: { event_id: eventId, user_id: userId, status: "going", created_at: at } })

describe("signupCohorts", () => {
  let result: Awaited<ReturnType<typeof signupCohorts>>

  beforeAll(async () => {
    const first = await night()
    const second = await night()
    const venue = await db.venues.create({ data: { name: testId("sc-venue"), city: "Bengaluru" } })
    venues.push(venue.id)
    const venueDay = await night({ kind: "venue_day", venue_id: venue.id, visibility: "unlisted" })

    // Week of 2 Mar: every window has closed.
    const a1 = ist("2020-03-03T10:00")
    const onTime = await person("sc-a1", a1)
    await rsvp(first.eventId, onTime, after(a1, 6))
    await came(first, onTime, after(a1, 3))
    await came(second, onTime, after(a1, 29))

    const a2 = ist("2020-03-03T10:00")
    const late = await person("sc-a2", a2)
    await rsvp(first.eventId, late, after(a2, 7.5)) // on day 8: not within 7
    await came(first, late, after(a2, 20)) // day 20: not within 14
    await came(second, late, after(a2, 30.5)) // on day 31: not a second event within 30

    const a3 = ist("2020-03-04T10:00")
    const venueGoer = await person("sc-a3", a3)
    await came(venueDay, venueGoer, after(a3, 1)) // going live at a venue is not a night
    await came(first, venueGoer, after(a3, 20))

    // 01:00 IST on Monday 2 Mar is 19:30 UTC on Sunday 1 Mar: India's week, not UTC's.
    await person("sc-a4", ist("2020-03-02T01:00"))

    const gone = await person("sc-a5", ist("2020-03-05T10:00"))
    await db.user.update({ where: { id: gone }, data: { deletedAt: ist("2020-03-06T10:00") } })

    // Week of 30 Mar: 7 and 14 days have passed for everybody, 30 have not.
    const b1 = ist("2020-03-31T10:00")
    const door = await person("sc-b1", b1, "door")
    await came(first, door, after(b1, 10))

    // Week of 6 Apr: 14 days have passed for one of the two, so the week's 14-day stage is not known yet.
    await person("sc-d1", ist("2020-04-06T10:00"))
    await person("sc-d2", ist("2020-04-12T10:00"))

    // Week of 13 Apr: five days old.
    const c1 = ist("2020-04-15T12:00")
    const young = await person("sc-c1", c1, "door")
    await came(second, young, after(c1, 1))

    result = await signupCohorts(8, NOW)
  })

  it("lists eight India weeks, newest first, an empty week included", () => {
    expect(result.weeks.map((w) => w.week)).toEqual([
      "2020-04-20", "2020-04-13", "2020-04-06", "2020-03-30", "2020-03-23", "2020-03-16", "2020-03-09", "2020-03-02",
    ])
    expect(result.weeks.find((w) => w.week === "2020-03-23")).toEqual({
      week: "2020-03-23", signedUp: 0, rsvp7: null, checkIn14: null, back30: null,
    })
  })

  it("counts an RSVP within 7 days, a check-in within 14 and a second event within 30, never a venue day", () => {
    // a4 is in by India's clock; the deleted account is not.
    expect(result.weeks.find((w) => w.week === "2020-03-02")).toEqual({
      week: "2020-03-02",
      signedUp: 4,
      rsvp7: { count: 1, of: 4 },
      checkIn14: { count: 1, of: 4 },
      back30: { count: 1, of: 4 },
    })
  })

  it("says a stage is not yet known, never a low number, until the whole week has had its window", () => {
    expect(result.weeks.find((w) => w.week === "2020-03-30")).toMatchObject({
      signedUp: 1, rsvp7: { count: 0, of: 1 }, checkIn14: { count: 1, of: 1 }, back30: null,
    })
    expect(result.weeks.find((w) => w.week === "2020-04-06")).toMatchObject({
      signedUp: 2, rsvp7: { count: 0, of: 2 }, checkIn14: null, back30: null,
    })
    // Checked in the day after signing up, and still "—" at five days old.
    expect(result.weeks.find((w) => w.week === "2020-04-13")).toMatchObject({
      signedUp: 1, rsvp7: null, checkIn14: null, back30: null,
    })
  })

  it("splits by source, unknown for none, each stage a share of the people whose window has closed", () => {
    expect(result.sources).toEqual([
      { source: "door", signedUp: 2, rsvp7: { count: 0, of: 1 }, checkIn14: { count: 1, of: 1 }, back30: null },
      { source: "unknown", signedUp: 6, rsvp7: { count: 1, of: 6 }, checkIn14: { count: 1, of: 5 }, back30: { count: 1, of: 4 } },
    ])
  })
})

describe("signupCohorts at its edges", () => {
  // Monday 20 Jul 2020, 12:00 IST; two weeks: 13 Jul and 20 Jul.
  const NOW2 = new Date("2020-07-20T12:00:00+05:30")

  it("counts a window up to its last instant and no further, orders sources as the constant, and keeps the bounds", async () => {
    const first = await night()
    // Exactly 7 days old: the 7-day stage is known, and an RSVP at the 7-day instant is outside it.
    const exact = await person("sc-e1", ist("2020-07-13T12:00"), "invite")
    await rsvp(first.eventId, exact, ist("2020-07-20T12:00"))
    const early = await person("sc-e2", ist("2020-07-13T10:00"), "link")
    await rsvp(first.eventId, early, ist("2020-07-14T10:00"))
    // No profile row at all: unknown.
    const bare = await makeUser(testId("sc-e3"))
    users.push(bare)
    await db.user.update({ where: { id: bare }, data: { createdAt: ist("2020-07-13T09:00") } })
    // 23:00 IST on Sunday 12 Jul is the week before; 13:00 IST on 20 Jul is after now.
    await person("sc-e4", ist("2020-07-12T23:00"), "door")
    await person("sc-e5", ist("2020-07-20T13:00"), "door")

    const edges = await signupCohorts(2, NOW2)
    expect(edges.weeks).toEqual([
      { week: "2020-07-20", signedUp: 0, rsvp7: null, checkIn14: null, back30: null },
      { week: "2020-07-13", signedUp: 3, rsvp7: { count: 1, of: 3 }, checkIn14: null, back30: null },
    ])
    expect(edges.sources.map((s) => [s.source, s.signedUp])).toEqual([["link", 1], ["invite", 1], ["unknown", 1]])
  })
})

describe("who receives it", () => {
  it("is sent to platform staff only, never to an organizer or a venue owner", async () => {
    const admin = await makeUser(testId("sc-admin"), "app_admin")
    const organizer = await makeUser(testId("sc-org"), "organizer")
    const owner = await makeUser(testId("sc-owner"), "organizer")
    users.push(admin, organizer, owner)
    await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
    // Each a member of an organisation of their kind: that is what their dashboard is (SCRUM-1247).
    for (const [id, kind] of [[organizer, "organizer"], [owner, "venue_owner"]] as const) {
      const org = await db.organisations.create({ data: { display_name: testId(`sc-${kind}`), kind: "company", status: "verified" } })
      hostOrgs.push(org.id)
      await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner" } })
      await db.organiser_onboarding_requests.create({
        data: { org_id: org.id, display_name: testId("sc-app"), contact_name: "S", contact_email: `${testId("sc-app")}@itest.invalid`, requested_role: kind, status: "approved" },
      })
    }

    session = { user: { id: admin, role: "app_admin" } }
    const staff = await getDashboardOverview()
    expect(staff).toHaveProperty("cohorts.weeks")
    expect(staff).toHaveProperty("cohorts.steps")
    expect(staff.role === "app_admin" && staff.cohorts.steps.map((s) => s.step)).toEqual([
      "none", "basics", "preferences", "details", "media", "location", "finished",
    ])
    for (const [id, role] of [[organizer, "organizer"], [owner, "venue_owner"]] as const) {
      session = { user: { id, role } }
      const overview = await getDashboardOverview()
      expect(overview.role).toBe(role)
      expect(overview).not.toHaveProperty("cohorts")
    }
  })
})

describe("where onboarding stopped (SCRUM-1283)", () => {
  // Monday 19 Oct 2020, 12:00 IST; two weeks: 12 Oct and 19 Oct. Everybody joins on Tue 13 Oct.
  const NOW3 = new Date("2020-10-19T12:00:00+05:30")
  const joined = ist("2020-10-13T10:00")
  const dob = new Date("1995-06-15")
  let category = ""

  afterAll(async () => {
    if (category) await db.categories.deleteMany({ where: { id: category } })
  })

  /** An account as sign-up leaves it (a profile with the name, `onboarded` false), then whatever its steps wrote. */
  async function starter(label: string, profile: Record<string, unknown> | null, at: Date = joined) {
    const id = await makeUser(testId(label))
    users.push(id)
    await db.user.update({ where: { id }, data: { createdAt: at } })
    if (profile) await db.profiles.create({ data: { id, name: `Test ${label}`, onboarded: false, ...profile } })
    return id
  }

  it("counts each unfinished account at the furthest step it filled, finished ones apart, and adds up to the sign-ups", async () => {
    category = (await db.categories.create({ data: { name: testId("ob-cat"), slug: testId("ob-cat") } })).id

    await starter("ob-signup", {}) // the name is sign-up's, not the basics step's
    await starter("ob-bare", null) // no profile row at all
    await starter("ob-basics", { date_of_birth: dob })
    await starter("ob-gender", { gender: "man" }) // gender alone is the basics step too
    await starter("ob-blank-bio", { date_of_birth: dob, bio: "  " }) // a cleared bio is not details
    await starter("ob-intent", { date_of_birth: dob, intent_default: ["networking"] })
    await starter("ob-reveal", { date_of_birth: dob, reveal_by_default: true })
    await starter("ob-orientation", { date_of_birth: dob, orientations: ["queer"] })
    await starter("ob-show", { date_of_birth: dob, show_orientation: true })
    await starter("ob-bio", { date_of_birth: dob, bio: "Ask me about trains" }) // bio but no photos
    const graph = await starter("ob-graph", { date_of_birth: dob })
    await db.user_interests.create({ data: { user_id: graph, category_id: category } })
    await starter("ob-names", { date_of_birth: dob, interests: ["Board games"] }) // the free-text names alone
    // All but location: sharing left on, which is also the column's default.
    await starter("ob-media", { date_of_birth: dob, gender: "woman", intent_default: ["friendship"], bio: "Hi", photos: ["https://x.invalid/p.jpg"] })
    await starter("ob-skipped", { date_of_birth: dob, photos: ["https://x.invalid/q.jpg"] }) // preferences and details skipped
    await starter("ob-location", { date_of_birth: dob, photos: ["https://x.invalid/r.jpg"], share_location: false })
    await starter("ob-done", { onboarded: true })
    const gone = await starter("ob-gone", { date_of_birth: dob })
    await db.user.update({ where: { id: gone }, data: { deletedAt: ist("2020-10-14T10:00") } })
    await starter("ob-before", { date_of_birth: dob }, ist("2020-10-11T23:00")) // the week before the two

    const result = await signupCohorts(2, NOW3)
    expect(result.steps).toEqual([
      { step: "none", people: 2 },
      { step: "basics", people: 3 },
      { step: "preferences", people: 4 },
      { step: "details", people: 3 },
      { step: "media", people: 2 },
      { step: "location", people: 1 },
      { step: "finished", people: 1 },
    ])
    const signedUp = result.weeks.reduce((n, w) => n + w.signedUp, 0)
    expect(result.steps.reduce((n, s) => n + s.people, 0)).toBe(signedUp)
    expect(signedUp).toBe(16)
  })
})
