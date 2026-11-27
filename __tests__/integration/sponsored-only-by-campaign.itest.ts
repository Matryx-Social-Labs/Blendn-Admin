import { NextRequest } from "next/server"

/*
 * Sponsored content reaches a room only through a campaign (SCRUM-1070, D-050).
 *
 * The campaign path (`lib/sponsored-scheduler.ts`) is the one with a person's
 * review of the creative, the gap between sponsored posts in a room and the
 * reach record. The host's broadcast doors — the mobile announce route and the
 * `createPoll` server action — take `announcement` (and, for an admin on the
 * route, `system`) and refuse `sponsored` with a sentence, whoever asks: here
 * a member of an organisation that may sponsor and holds an approved placement
 * at the event, the strongest grant there is. Real rows; the socket is mocked.
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
const { emitChatMessage } = require("@/lib/socket-server") as { emitChatMessage: jest.Mock }
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const sponsors: string[] = []
let eventId = ""
let groupId = ""
let host = ""
let brandMember = ""

afterAll(async () => {
  await db.event_sponsors.deleteMany({ where: { event_id: { in: events } } })
  await db.sponsors.deleteMany({ where: { id: { in: sponsors } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await db.event_announcements.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function orgOf(userId: string, maySponsor = false) {
  const org = await db.organisations.create({
    data: { kind: "company", display_name: testId("soc-org"), status: "verified", may_sponsor: maySponsor },
  })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: userId, role: "owner" } })
  return org.id
}

beforeAll(async () => {
  host = await makeUser(testId("soc-host"), "organizer")
  brandMember = await makeUser(testId("soc-brand"))
  users.push(host, brandMember)
  await db.user.update({ where: { id: brandMember }, data: { role: "sponsor" } })
  const hostOrg = await orgOf(host)
  const brandOrg = await orgOf(brandMember, true)

  eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: hostOrg } })
  groupId = (await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" }, select: { id: true } })).id

  const name = testId("soc-brand-name")
  const sponsor = await db.sponsors.create({ data: { name, name_key: name.toLowerCase(), org_id: brandOrg } })
  sponsors.push(sponsor.id)
  await db.event_sponsors.create({ data: { event_id: eventId, sponsor_id: sponsor.id, status: "approved", created_by: host } })
})

beforeEach(() => emitChatMessage.mockClear())

const inRoom = () => db.chat_messages.count({ where: { chat_group_id: groupId } })
const announcements = () => db.event_announcements.count({ where: { event_id: eventId } })
const polls = () => db.chat_polls.count({ where: { message: { chat_group_id: groupId } } })

async function post(userId: string, body: object) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return announce.POST(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/announce`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(userId, email)}`, "x-real-ip": "10.70.0.1" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId }) }
  )
}

describe("POST /api/mobile/events/:id/announce", () => {
  it("refuses kind sponsored from an organisation with an approved placement, and writes nothing", async () => {
    const res = await post(brandMember, { kind: "sponsored", content: "Two for one at the bar" })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/campaign/i)
    expect(await announcements()).toBe(0)
    expect(await inRoom()).toBe(0)
    expect(emitChatMessage).not.toHaveBeenCalled()
  })

  it("refuses kind sponsored from the host as well", async () => {
    const res = await post(host, { kind: "sponsored", content: "Brought to you by us" })

    expect(res.status).toBe(400)
    expect(await announcements()).toBe(0)
    expect(await inRoom()).toBe(0)
  })

  it("still delivers the host's announcement, one row", async () => {
    const res = await post(host, { content: "Doors close at eleven" })

    expect(res.status).toBe(200)
    expect(await announcements()).toBe(1)
    const rows = await db.chat_messages.findMany({ where: { chat_group_id: groupId }, select: { type: true, content: true } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: "announcement", content: expect.stringContaining("Doors close at eleven") })
    await db.chat_messages.deleteMany({ where: { chat_group_id: groupId } })
    await db.event_announcements.deleteMany({ where: { event_id: eventId } })
  })
})

describe("createPoll", () => {
  it("refuses kind sponsored from an organisation with an approved placement, and writes nothing", async () => {
    mockGetAuth.mockResolvedValue({ user: { id: brandMember, role: "sponsor" } })

    await expect(
      createPoll(eventId, { question: "Which flavour?", options: ["Original", "Sugarfree"], kind: "sponsored" })
    ).rejects.toThrow(/campaign/i)
    expect(await polls()).toBe(0)
    expect(await inRoom()).toBe(0)
    expect(emitChatMessage).not.toHaveBeenCalled()
  })

  it("still posts the host's poll", async () => {
    mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })

    const { pollId } = await createPoll(eventId, { question: "Encore?", options: ["Yes", "No"] })

    expect(await db.chat_polls.count({ where: { id: pollId } })).toBe(1)
    expect(await polls()).toBe(1)
    const row = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: groupId }, select: { metadata: true } })
    expect(row.metadata).toMatchObject({ poll: true, kind: "announcement" })
  })
})
