import { NextRequest } from "next/server"

/*
 * The host's pinned Lobby post (SCRUM-1026): written by whoever the event's
 * organisation lets edit it — a colleague exactly as the creator, nobody else
 * — shown under the organisation's name and never a person's, audited at every
 * change. Real rows; the session and the push are faked.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
const mockHostPush = jest.fn().mockResolvedValue({ sent: 0, failed: 0 })
jest.mock("@/lib/push-notifications", () => ({
  ...jest.requireActual("@/lib/push-notifications"),
  notifyLobbyHostPost: (...a: unknown[]) => mockHostPush(...a),
}))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const pin = require("@/app/api/events/[id]/lobby-pin/route") as typeof import("@/app/api/events/[id]/lobby-pin/route")
const board = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
let eventId = ""
let creator = ""
let colleague = ""
let rival = ""
let venueOwner = ""
let attendee = ""
let orgName = ""

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.board_alert_preferences.deleteMany({ where: { event_id: { in: events } } })
  await db.board_host_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function org(...members: string[]) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId("Kerala Design Week & Friends"), status: "verified" }, select: { id: true, display_name: true } })
  orgs.push(o.id)
  for (const [i, user_id] of members.entries()) await db.organisation_members.create({ data: { org_id: o.id, user_id, role: i === 0 ? "owner" : "staff" } })
  return o
}

beforeAll(async () => {
  creator = await makeUser(testId("pin-creator"), "organizer")
  colleague = await makeUser(testId("pin-colleague"), "organizer")
  rival = await makeUser(testId("pin-rival"), "organizer")
  venueOwner = await makeUser(testId("pin-venue"))
  attendee = await makeUser(testId("pin-attendee"))
  users.push(creator, colleague, rival, venueOwner, attendee)
  await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
  const hostOrg = await org(creator, colleague)
  orgName = hostOrg.display_name as string
  await org(rival)
  const venueOrg = await org(venueOwner)
  const venue = await db.venues.create({ data: { name: testId("pin-venue"), city: "Bangalore", owner_org_id: venueOrg.id, claimed_at: new Date() }, select: { id: true } })
  venues.push(venue.id)
  eventId = await makeEvent(creator)
  events.push(eventId)
  const start = new Date(Date.now() + 24 * 3_600_000)
  await db.events.update({
    where: { id: eventId },
    data: { organizer_org_id: hostOrg.id, venue_id: venue.id, venue_link_status: "auto_linked", start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) },
  })
  await onboard(attendee)
  await db.event_favorites.create({ data: { event_id: eventId, user_id: attendee } })
})

const as = (id: string | null, role = "organizer") => mockGetAuth.mockResolvedValue(id ? { user: { id, role } } : null)
const ctx = () => ({ params: Promise.resolve({ id: eventId }) })
const put = (body: object) => pin.PUT(new Request("http://localhost/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx())
const del = () => pin.DELETE(new Request("http://localhost/x", { method: "DELETE" }), ctx())
const audits = (action: string) => db.audit_logs.count({ where: { action, resource: "event", resource_id: eventId } })
const asAttendeeReads = async () => {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: attendee }, select: { email: true } })
  const res = await board.GET(new NextRequest(`http://localhost/x`, { headers: { authorization: `Bearer ${signAccessToken(attendee, email)}` } }), { params: Promise.resolve({ eventId }) })
  return (await res.json()).data
}

describe("who may pin", () => {
  it("refuses the signed-out, an attendee, another organisation, and the venue's owner (who operates, not edits)", async () => {
    as(null)
    expect((await put({ body: "x" })).status).toBe(401)
    for (const [id, role] of [[attendee, "attendee"], [rival, "organizer"], [venueOwner, "venue_owner"]] as const) {
      as(id, role)
      expect((await put({ body: "Doors at 6" })).status).toBe(403)
      expect((await del()).status).toBe(403)
    }
    expect(await db.board_host_posts.count({ where: { event_id: eventId } })).toBe(0)
  })

  it("lets the creator pin, under the organisation's name, audited", async () => {
    as(creator)
    const res = await put({ body: "Doors at 6 sharp. Entry is from the side lane on 15th Cross." })
    expect(res.status).toBe(200)
    expect((await res.json()).pinned).toMatchObject({ host: orgName, body: "Doors at 6 sharp. Entry is from the side lane on 15th Cross." })
    expect(await audits("lobby.pin.set")).toBe(1)

    // What an attendee reads: the organisation, and nothing of the person.
    const read = await asAttendeeReads()
    expect(read.pinned).toMatchObject({ host: orgName })
    const creatorRow = await db.user.findUniqueOrThrow({ where: { id: creator }, select: { name: true, email: true } })
    const text = JSON.stringify(read)
    expect(text).not.toContain(creator)
    expect(text).not.toContain(creatorRow.name as string)
    expect(text).not.toContain(creatorRow.email)
  })

  it("lets a colleague at the same organisation edit it, audited as an edit, and tells the people who asked", async () => {
    await db.board_alert_preferences.create({ data: { user_id: attendee, event_id: eventId, host_posts: true } })
    as(colleague)
    expect((await put({ body: "Doors at 6:30 now." })).status).toBe(200)
    expect(await audits("lobby.pin.edit")).toBe(1)
    expect((await db.board_host_posts.findUniqueOrThrow({ where: { event_id: eventId } })).written_by).toBe(colleague)
    await new Promise((r) => setTimeout(r, 50))
    expect(mockHostPush).toHaveBeenCalledWith([attendee], expect.objectContaining({ id: eventId }), expect.any(String), "Doors at 6:30 now.")
  })

  it("refuses an empty or over-long note", async () => {
    as(creator)
    expect((await put({ body: "" })).status).toBe(400)
    expect((await put({ body: "x".repeat(501) })).status).toBe(400)
    await expect(db.board_host_posts.update({ where: { event_id: eventId }, data: { body: "" } })).rejects.toThrow(/board_host_posts_body_length/)
  })

  it("counts characters as the CHECK does (char_length): 500 emoji fit and are stored, the 501st is refused", async () => {
    as(creator)
    const full = "🎉".repeat(500)
    expect((await put({ body: full })).status).toBe(200)
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT char_length(body)::int AS n FROM board_host_posts WHERE event_id = ${eventId}::uuid`
    expect(row.n).toBe(500)
    const audit = await db.audit_logs.findFirst({ where: { action: "lobby.pin.edit", resource_id: eventId }, orderBy: { created_at: "desc" }, select: { details: true } })
    expect(audit?.details).toMatchObject({ length: 500 })
    expect((await put({ body: `${full}🎉` })).status).toBe(400)
  })

  it("unpins, audited, and the Lobby has no pinned post", async () => {
    as(creator)
    expect(await (await del()).json()).toEqual({ pinned: null, removed: true })
    expect(await audits("lobby.pin.clear")).toBe(1)
    expect((await asAttendeeReads()).pinned).toBeNull()
  })

  it("refuses a pin once the Lobby has closed", async () => {
    await db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - 30 * 3_600_000), end_time: new Date(Date.now() - 25 * 3_600_000) } })
    as(creator)
    expect((await put({ body: "Too late" })).status).toBe(409)
  })
})
