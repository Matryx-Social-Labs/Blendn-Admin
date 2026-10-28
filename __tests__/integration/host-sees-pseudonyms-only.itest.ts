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
import { eventAttendees } from "@/lib/attendee-roster"
import { buildFeedbackDigest } from "@/lib/feedback-digest"
import { maySeeIdentityFor, visibleInRoom } from "@/lib/identity"
import { buildLiveSnapshot } from "@/lib/live-snapshot"
import { actorFor } from "@/lib/org-membership"
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
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: hostOrg, venue_id: venueId } })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: host, role: "admin" } })
  const start = Math.floor((Date.now() - 50 * MINUTE) / MINUTE) * MINUTE
  const people = [ana, ...others]
  for (const [i, user_id] of people.entries()) {
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id, anonymous_name: `Zq Pseudo ${i}` } })
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
    expect(JSON.stringify(body)).toContain("Zq Pseudo 0")
    expectNoIdentity("chat feed", body)

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

describe("the export's arrival times cannot be lined up against the room (L3, L4)", () => {
  const rows = (csv: string) => csv.split("\r\n").slice(1).filter(Boolean).map((l) => l.split(","))

  it("gives a host arrivals to the quarter hour, in label order, and none for a night of fewer than five", async () => {
    const csv = await buildReport("check-ins", "organizer", host, RANGE())
    const [header] = csv.split("\r\n")
    expect(header).toBe("Checked in at,Status,Attendee,Event ID,Event,Event start")
    const attendeesOf = (eventId: string) => rows(csv).filter((r) => r[3] === eventId && r[2].startsWith("attendee-"))
    const a = attendeesOf(eventA)
    expect(a.length).toBeGreaterThanOrEqual(5)
    for (const r of a) expect(r[0]).toMatch(/T\d\d:(00|15|30|45):00\.000Z$/)
    const labels = a.map((r) => r[2])
    expect(labels).toEqual([...labels].sort())
    const b = attendeesOf(eventB)
    expect(b.length).toBeGreaterThan(0)
    for (const r of b) expect(r[0]).toBe("")
  })

  it("gives a host the day of a person's last night, not its minute", async () => {
    const csv = await buildReport("attendees", "organizer", host, RANGE())
    expect(csv.split("\r\n")[0]).toBe("Attendee,Events attended,Last attended,Repeat")
    for (const r of rows(csv)) expect(r[2]).toMatch(/^\d{4}-\d\d-\d\d$/)
  })

  it("keeps the exact time for the platform's admin", async () => {
    const csv = await buildReport("check-ins", "app_admin", admin, RANGE())
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
