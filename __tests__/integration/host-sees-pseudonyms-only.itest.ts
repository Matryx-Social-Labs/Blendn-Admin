import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { NextRequest } from "next/server"

import { GET as roomFeed } from "@/app/api/events/[id]/chat/messages/route"
import { GET as flagQueue } from "@/app/api/events/[id]/chat/moderation/route"
import { attendeeRoster, eventAttendees } from "@/lib/attendee-roster"
import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { maySeeIdentityFor, visibleInRoom } from "@/lib/identity"
import { buildLiveSnapshot } from "@/lib/live-snapshot"
import { actorFor } from "@/lib/org-membership"
import { attendeeLabel } from "@/lib/pseudonym"
import { buildReport } from "@/lib/reports"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * SCRUM-887, owner ruling 2026-10-28: a host sees a person only by their room
 * pseudonym. Never a real name, email, phone, photo or a stable id that joins
 * back to one -- even for somebody who chose to be named in the room (that is
 * for the other attendees, in the app). `app_admin` keeps real identity.
 *
 * One attendee, Ana, carries a distinctive name, email, phone and photo, and
 * reveals herself in the room. Every host-facing builder and route is read as
 * the organiser, a staff colleague of theirs and the venue owner, and its
 * serialised output must hold none of her identity. The admin reads the room
 * as the control: her identity is there, so the tokens below are the right
 * ones to look for.
 *
 * The host in the app is the second half (L2): a host checked in to their own
 * room is not "in the room" for identity, so a reveal there shows them nothing,
 * while an ordinary attendee beside them still sees it.
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
const MINUTE = 60_000

let host = ""
let colleague = ""
let owner = ""
let admin = ""
let ana = ""
let ben = ""
let eventA = ""
let eventB = ""
let eventC = ""

const ANA = { name: "", email: "", image: "https://cdn.itest.invalid/zq-ana-face.jpg", phone: "+919800012345" }
const identityOf = () => [ana, ANA.name, ANA.email, ANA.image, ANA.phone]

function expectNoIdentity(label: string, value: unknown) {
  const json = JSON.stringify(value)
  for (const token of identityOf()) {
    if (json.includes(token)) throw new Error(`${label} carries "${token}"`)
  }
}

async function org(label: string, member: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: member, role: "owner" } })
  return o.id
}

async function checkIn(eventId: string, userId: string, at: Date, status: "checked_in" | "checked_out", kind: "attendee" | "staff" = "attendee") {
  const occ = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId }, select: { id: true } })
  await db.event_check_ins.create({
    data: { event_id: eventId, occurrence_id: occ.id, user_id: userId, kind, status, check_in_time: at, created_at: at },
  })
}

/** Ana and four others in the room; the host and their colleague and the venue owner checked in as staff. */
async function room(eventId: string, hostOrg: string, venueId: string, others: string[], status: "checked_in" | "checked_out") {
  // Settled: over, and the last arrival, more than two hours ago (`settledEventIds`).
  // On the hour, so A's five arrivals (28 minutes) share one hour's cell.
  const start = Math.floor((Date.now() - 6 * 60 * MINUTE) / (60 * MINUTE)) * 60 * MINUTE
  const times = { start_time: new Date(start), end_time: new Date(Date.now() - 3 * 60 * MINUTE) }
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: hostOrg, venue_id: venueId, ...times } })
  await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: times })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: host, role: "admin" } })
  const people = [ana, ...others]
  for (const [i, user_id] of people.entries()) {
    // Named against the door's order, so a list in row order is not also in name order.
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id, anonymous_name: `Zq Pseudo ${people.length - i}` } })
    // Seconds off the quarter hour on purpose: the export must not repeat them.
    await checkIn(eventId, user_id, new Date(start + i * 7 * MINUTE + 13_000), status)
  }
  for (const staff of [host, colleague, owner]) await checkIn(eventId, staff, new Date(start), status, "staff")
  // Ana chooses to be named in this room.
  await db.event_match_preferences.create({ data: { event_id: eventId, user_id: ana, revealed: true } })
  const said = await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: ana, content: "the queue is long" },
    select: { id: true },
  })
  await db.moderation_flags.create({
    data: { message_id: said.id, chat_group_id: group.id, user_id: ana, source: "user_report", confidence: 1, categories: {} },
  })
  await db.event_feedback.create({
    data: { event_id: eventId, message_id: said.id, sentiment: "negative", category: "entry_queue", confidence: 0.9, source: "lexicon" },
  })
  await db.event_ratings.create({ data: { event_id: eventId, user_id: ana, rating: 2 } })
}

beforeAll(async () => {
  host = await makeUser("hspo-host", "organizer")
  colleague = await makeUser("hspo-colleague", "organizer")
  owner = await makeUser("hspo-owner", "organizer")
  admin = await makeUser("hspo-admin", "app_admin")
  ana = await makeUser("hspo-ana")
  ben = await makeUser("hspo-ben")
  const extras = [await makeUser("hspo-x1"), await makeUser("hspo-x2"), await makeUser("hspo-x3")]
  users.push(host, colleague, owner, admin, ana, ben, ...extras)
  await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
  ANA.name = `Zqana Leakname ${ana.slice(-6)}`
  ANA.email = `${ana}@itest.invalid`
  await db.user.update({ where: { id: ana }, data: { name: ANA.name, image: ANA.image } })
  await db.profiles.create({ data: { id: ana, name: ANA.name, phone: ANA.phone, onboarded: true } })

  const hostOrg = await org("hspo-host-org", host)
  await db.organisation_members.create({ data: { org_id: hostOrg, user_id: colleague, role: "staff" } })
  const venueOrg = await org("hspo-venue-org", owner)
  const venue = await db.venues.create({
    data: { name: testId("hspo-venue"), latitude: 12.9, longitude: 77.5, owner_org_id: venueOrg, claimed_at: new Date(Date.now() - 30 * 86_400_000) },
    select: { id: true },
  })
  venues.push(venue.id)

  eventA = await makeEvent(host)
  eventB = await makeEvent(host)
  events.push(eventA, eventB)
  await room(eventA, hostOrg, venue.id, [ben, ...extras], "checked_in")
  // A night Ana came to nearly alone: who came, and when, is held back.
  await room(eventB, hostOrg, venue.id, [], "checked_out")
  // A night still running, somebody arriving ten minutes ago: no host export holds it.
  eventC = await makeEvent(host)
  events.push(eventC)
  await db.events.update({ where: { id: eventC }, data: { organizer_org_id: hostOrg } })
  const late = await makeUser("hspo-late")
  users.push(late)
  await checkIn(eventC, late, new Date(Date.now() - 10 * MINUTE), "checked_in")
})

afterAll(async () => {
  await db.event_feedback.deleteMany({ where: { event_id: { in: events } } })
  await db.event_ratings.deleteMany({ where: { event_id: { in: events } } })
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.events.updateMany({ where: { id: { in: events } }, data: { venue_id: null } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

const req = (path: string) => new NextRequest(`http://localhost${path}`)
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const RANGE = () => ({ key: "custom" as const, from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + MINUTE) })

const HOSTS = [
  ["the organiser", "organizer", () => host],
  ["their staff colleague", "organizer", () => colleague],
  ["the venue owner", "venue_owner", () => owner],
] as const

describe.each(HOSTS)("%s sees pseudonyms only", (_who, role, id) => {
  it("in the Room chat feed and the moderation queue", async () => {
    as(role, id())
    const feed = await roomFeed(req(`/api/events/${eventA}/chat/messages`), ctx(eventA))
    expect(feed.status).toBe(200)
    const body = await feed.json()
    expect(JSON.stringify(body)).toContain("Zq Pseudo 5")
    expectNoIdentity("chat feed", body)
    // The members by pseudonym, never in the order they walked in (SCRUM-887).
    const names = (body.members as { anonymousName: string | null }[]).map((m) => m.anonymousName).filter(Boolean)
    expect(names).toEqual([...names].sort())

    const flags = await flagQueue(req(`/api/events/${eventA}/chat/moderation?status=all`), ctx(eventA))
    expect(flags.status).toBe(200)
    expectNoIdentity("moderation queue", await flags.json())
  })

  it("in the attendee list, the feedback digest and the live snapshot", async () => {
    const actor = await actorFor({ id: id(), role })
    expectNoIdentity("attendees tab", await eventAttendees(actor, eventA))
    const event = await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { id: true, title: true, end_time: true, timezone: true } })
    expectNoIdentity("feedback digest", await buildFeedbackDigest(event, role === "venue_owner" ? "venue" : "host"))
    expectNoIdentity("live snapshot", await buildLiveSnapshot(eventA))
  })

  it("in every export it may run", async () => {
    for (const key of ["events", "check-ins", ...(role === "organizer" ? (["attendees"] as const) : [])] as const) {
      expectNoIdentity(`${key} export`, await buildReport(key, role, id(), RANGE()))
    }
  })

  it("in their own room in the app, though Ana revealed there (L2)", async () => {
    // A host checked in to their own room is not in it for identity.
    expect([...(await visibleInRoom(id(), eventA, [ana]))]).toEqual([])
    // Nor through the unscoped gate's "public in a room you were in".
    expect([...(await maySeeIdentityFor(id(), [ana]))]).toEqual([])
  })
})

describe("a host's exports cannot be lined up against the room (L3, L4)", () => {
  const rows = (csv: string) => csv.split("\r\n").slice(1).filter(Boolean).map((l) => l.split(","))
  const from = () => new Date(Date.now() - 86_400_000)

  it("gives a host arrivals per hour as counts, never a row per person, and under five as <5", async () => {
    const csv = await buildReport("check-ins", "organizer", host, RANGE())
    expect(csv.split("\r\n")[0]).toBe("Event ID,Event,Event start,Hour (UTC),Arrivals")
    expect(csv).not.toContain("attendee-")
    // Five arrived at A inside one hour; the staff who checked in are not guests.
    expect(rows(csv).filter((r) => r[0] === eventA).map((r) => r.slice(3))).toEqual([[expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:00Z$/), "5"]])
    // One arrived at B: a cell under the floor.
    expect(rows(csv).filter((r) => r[0] === eventB).map((r) => r[4])).toEqual(["<5"])
  })

  it("gives a host the day of a person's last night, not its minute", async () => {
    const csv = await buildReport("attendees", "organizer", host, RANGE())
    expect(csv.split("\r\n")[0]).toBe("Attendee,Events attended,Last attended,Repeat")
    for (const r of rows(csv)) expect(r[2]).toMatch(/^\d{4}-\d\d-\d\d$/)
  })

  /*
   * The security review's attacks: move the window's end across one arrival,
   * or the event's own end time (the host's to edit), and diff the exports.
   * Chosen by check-in time, the row that moved was that arrival. Chosen by
   * whole events and counted, nothing moves.
   */
  it("gives a host the same exports whichever minute the window ends on", async () => {
    const last = await db.event_check_ins.findFirstOrThrow({
      where: { event_id: eventA, kind: "attendee" },
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    })
    const before = { key: "custom" as const, from: from(), to: new Date(last.created_at.getTime() - MINUTE) }
    const after = { key: "custom" as const, from: from(), to: new Date(last.created_at.getTime() + MINUTE) }
    for (const key of ["check-ins", "attendees"] as const) {
      expect(await buildReport(key, "organizer", host, before)).toBe(await buildReport(key, "organizer", host, after))
    }
  })

  const exports = () =>
    Promise.all((["check-ins", "attendees"] as const).map((key) => buildReport(key, "organizer", host, RANGE())))
  const moveEnd = async (eventId: string, end_time: Date) => {
    await db.events.update({ where: { id: eventId }, data: { end_time } })
    await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { end_time } })
  }

  it("leaves a night that is still arriving out of a host's exports, not out of the admin's", async () => {
    for (const csv of await exports()) expect(csv).not.toContain(eventC)
    expect(await buildReport("check-ins", "app_admin", admin, RANGE())).toContain(eventC)
  })

  it("does not open a night's exports when the host moves its end into the past", async () => {
    const was = await db.events.findUniqueOrThrow({ where: { id: eventC }, select: { end_time: true } })
    await moveEnd(eventC, new Date(Date.now() - 3 * 60 * MINUTE))
    const moved = await exports()
    await moveEnd(eventC, was.end_time)
    // Somebody arrived ten minutes ago: the arrivals, not the host's times, keep it shut.
    for (const csv of moved) expect(csv).not.toContain(eventC)
  })

  it("gives a host the same exports when they move a settled night's end and back", async () => {
    const was = await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { end_time: true } })
    const before = await exports()
    await moveEnd(eventA, new Date(was.end_time.getTime() - 60 * MINUTE))
    const moved = await exports()
    await moveEnd(eventA, was.end_time)
    expect(moved).toEqual(before)
  })

  it("gives the organisation's list a night's start as last attended, never a check-in's time", async () => {
    const listed = await attendeeRoster("organizer", host)
    expect(listed.rows.length).toBeGreaterThan(0)
    const starts = (await db.events.findMany({ where: { id: { in: [eventA, eventB] } }, select: { start_time: true } })).map((e) => e.start_time.toISOString())
    for (const r of listed.rows) if (r.lastAttendedAt) expect(starts).toContain(r.lastAttendedAt)
  })

  /*
   * Settle-once (SCRUM-887, security review): a night's host lists close the
   * first time it settles (`events.host_settled_at`, written once). A check-in
   * after that, or the host moving the night's times, never changes them.
   */
  it("settles a night once: a late check-in and a moved end change no host list or export, and not the admin's", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const lists = async () => [await exports(), await eventAttendees(actor, eventA), (await attendeeRoster("organizer", host)).rows]
    const first = await lists()
    const settled = await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { host_settled_at: true, end_time: true } })
    expect(settled.host_settled_at).not.toBeNull()

    const late = await makeUser("hspo-late-a")
    users.push(late)
    // After the settle, as every late arrival is.
    await checkIn(eventA, late, new Date(), "checked_out")
    await moveEnd(eventA, new Date(Date.now() + 60 * MINUTE))
    try {
      expect(await lists()).toEqual(first)
      // Written once: a second settle neither moves nor clears it.
      expect((await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { host_settled_at: true } })).host_settled_at).toEqual(settled.host_settled_at)
      // The admin's rows are the check-ins as they are.
      const lateLabel = attendeeLabel(late, "platform")
      expect(await buildReport("attendees", "app_admin", admin, RANGE())).toContain(lateLabel)
    } finally {
      await moveEnd(eventA, settled.end_time)
      await db.event_check_ins.deleteMany({ where: { user_id: late } })
    }
  })

  it("keeps somebody who came before the settle, and only them, when they check in again after it", async () => {
    const actor = await actorFor({ id: host, role: "organizer" })
    const lists = async () => [await exports(), await eventAttendees(actor, eventA), (await attendeeRoster("organizer", host)).rows]
    const before = await lists()
    // The check-in upsert moves `check_in_time` on a re-check-in; the row's `created_at` stays.
    const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: eventA, user_id: ben }, select: { id: true, check_in_time: true } })
    await db.event_check_ins.update({ where: { id: row.id }, data: { check_in_time: new Date() } })
    try {
      expect(await lists()).toEqual(before)
    } finally {
      await db.event_check_ins.update({ where: { id: row.id }, data: { check_in_time: row.check_in_time } })
    }
  })

  it("never re-settles: a late arrival older than the grace stays out of a host's lists", async () => {
    const was = (await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { host_settled_at: true } })).host_settled_at
    // Settled four hours ago; somebody checked in an hour after that.
    const settledAt = new Date(Date.now() - 4 * 60 * MINUTE)
    await db.events.update({ where: { id: eventA }, data: { host_settled_at: settledAt } })
    const late = await makeUser("hspo-late-b")
    users.push(late)
    await checkIn(eventA, late, new Date(settledAt.getTime() + 60 * MINUTE), "checked_out")
    try {
      const lateLabel = attendeeLabel(late, (await actorFor({ id: host, role: "organizer" })).orgIds[0])
      expect(await buildReport("attendees", "organizer", host, RANGE())).not.toContain(lateLabel)
      expect((await db.events.findUniqueOrThrow({ where: { id: eventA }, select: { host_settled_at: true } })).host_settled_at).toEqual(settledAt)
    } finally {
      await db.event_check_ins.deleteMany({ where: { user_id: late } })
      await db.events.update({ where: { id: eventA }, data: { host_settled_at: was } })
    }
  })

  it("gives a host no per-person list for a night that has not settled, and says when it will", async () => {
    const out = await eventAttendees(await actorFor({ id: host, role: "organizer" }), eventC)
    expect(out).toMatchObject({ view: "labels", rows: [], pending: true })
  })

  it("keeps a row per check-in, to the second, for the platform's admin", async () => {
    const csv = await buildReport("check-ins", "app_admin", admin, RANGE())
    expect(csv.split("\r\n")[0]).toBe("Checked in at,Status,Attendee,Event ID,Event,Event start")
    expect(rows(csv).some((r) => r[3] === eventA && /:13\.000Z$/.test(r[0]))).toBe(true)
  })
})

describe("the controls", () => {
  it("an ordinary attendee in the room still sees Ana, who revealed there", async () => {
    expect([...(await visibleInRoom(ben, eventA, [ana]))]).toEqual([ana])
  })

  it("the platform's admin reads her real identity in the room feed and the queue", async () => {
    as("app_admin", admin)
    const feed = JSON.stringify(await (await roomFeed(req(`/api/events/${eventA}/chat/messages`), ctx(eventA))).json())
    expect(feed).toContain(ana)
    expect(feed).toContain(ANA.name)
    expect(feed).toContain(ANA.email)
    expect(feed).toContain(ANA.image)
    const flags = JSON.stringify(await (await flagQueue(req(`/api/events/${eventA}/chat/moderation?status=all`), ctx(eventA))).json())
    expect(flags).toContain(ANA.email)
  })
})
