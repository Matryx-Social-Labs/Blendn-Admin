import { NextRequest } from "next/server"

/*
 * A venue owner operates an event in their building; they do not announce into
 * it (SCRUM-335).
 *
 * R37 took the composer away from them — the messaging page shows it only on
 * `canEdit`, and `POST /api/events/[id]/announcements` refuses them (driven on
 * staging as venue.owner@: 403, nothing written). But `canBroadcast` still
 * answered "announcement" with `canOperate`, and `createPoll` — a server
 * action, callable without the page — gates on nothing else. A poll's `kind`
 * defaults to "announcement", and `broadcastAuthorName` signs it with the
 * organising org's name, so the venue owner's question went out under someone
 * else's. Real rows; the socket is mocked.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({ ...jest.requireActual("@/lib/socket-server"), emitChatMessage: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const { createPoll } = require("@/lib/poll-actions") as typeof import("@/lib/poll-actions")
const announce = require("@/app/api/mobile/events/[eventId]/announce/route") as typeof import("@/app/api/mobile/events/[eventId]/announce/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
let eventId = ""
let groupId = ""
let host = ""
let venueOwner = ""

afterAll(async () => {
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function orgOf(userId: string) {
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("ane-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: userId, role: "owner" } })
  return org.id
}

beforeAll(async () => {
  host = await makeUser(testId("ane-host"), "organizer")
  venueOwner = await makeUser(testId("ane-venue"))
  users.push(host, venueOwner)
  await db.user.update({ where: { id: venueOwner }, data: { role: "venue_owner" } })
  const hostOrg = await orgOf(host)
  const venue = await db.venues.create({
    data: { name: testId("ane-venue"), city: "Bangalore", owner_org_id: await orgOf(venueOwner), claimed_at: new Date() },
  })
  venues.push(venue.id)
  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({
    where: { id: eventId },
    data: { organizer_org_id: hostOrg, venue_id: venue.id, venue_link_status: "auto_linked" },
  })
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id
})

const inRoom = () => db.chat_messages.count({ where: { chat_group_id: groupId } })
const polls = () => db.chat_polls.count({ where: { message: { chat_group_id: groupId } } })

describe("the venue owner", () => {
  beforeAll(() => mockGetAuth.mockResolvedValue({ user: { id: venueOwner, role: "venue_owner" } }))

  it("cannot post a poll into the room — it is an announcement", async () => {
    await expect(createPoll(eventId, { question: "Last orders at 11?", options: ["Yes", "No"] })).rejects.toThrow("Forbidden")
    await expect(
      createPoll(eventId, { question: "Say it louder", options: ["A", "B"], kind: "announcement" })
    ).rejects.toThrow("Forbidden")
    expect(await inRoom()).toBe(0)
    expect(await polls()).toBe(0)
  })

  it("cannot announce through the mobile route either", async () => {
    // Unreachable today (mobile sign-in refuses dashboard roles), and one sign-in
    // change from reachable; it asks the same `canBroadcast`.
    const { email } = await db.user.findUniqueOrThrow({ where: { id: venueOwner }, select: { email: true } })
    const res = await announce.POST(
      new NextRequest(`http://localhost/api/mobile/events/${eventId}/announce`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(venueOwner, email)}`, "x-real-ip": "10.35.0.1" },
        body: JSON.stringify({ content: "Doors close at midnight" }),
      }),
      { params: Promise.resolve({ eventId }) }
    )
    expect(res.status).toBe(403)
    expect(await inRoom()).toBe(0)
  })
})

it("the organiser still posts a poll", async () => {
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
  const { pollId } = await createPoll(eventId, { question: "Encore?", options: ["Yes", "No"] })
  expect(await db.chat_polls.count({ where: { id: pollId } })).toBe(1)
  expect(await polls()).toBe(1)
})
