import type { DashboardRole } from "@/lib/dashboard-types"

let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const as = (role: DashboardRole, id: string) => {
  session = { user: { id, role } }
}

import { NextRequest } from "next/server"

import { GET as roomFeed } from "@/app/api/events/[id]/chat/messages/route"
import { GET as flagQueue } from "@/app/api/events/[id]/chat/moderation/route"
import { PATCH as moderateMember } from "@/app/api/events/[id]/chat/members/[userId]/route"
import { getAuditLog } from "@/lib/audit-actions"
import { resolveUserRef, roomHandle } from "@/lib/room-handle"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/*
 * SCRUM-517: the dashboard chat API gave a host every attendee's real account
 * id. The id is the same in every room, so a host running several nights — or
 * a venue whose rooms they all are — could join them into a per-person history,
 * which the pseudonym and the label exist to prevent; and a host holding a
 * friend's real id could unmask that friend's pseudonym.
 *
 * Hosts get the room handle (SCRUM-371): one person, one handle, in one room,
 * unrelated in the next. An admin keeps the real id. Asserted on the wire —
 * the serialised JSON that reaches the browser — for an organiser and for a
 * venue owner, and through the ban/mute route that takes the id back.
 */
const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const venues: string[] = []
const DAY = 86_400_000

let host = ""
let owner = ""
let admin = ""
let ana = ""
let ben = ""
let colleague = ""
let stranger = ""
let eventA = ""
let eventB = ""
let groupA = ""

async function org(label: string, member: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: member, role: "owner" } })
  return o.id
}

/** A room with Ana and Ben talking, the host holding it, and one flag on Ana. */
async function room(eventId: string, hostOrg: string, venueId: string) {
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: hostOrg, venue_id: venueId } })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: host, role: "admin" } })
  for (const [user_id, anonymous_name] of [[ana, "Quiet Otter"], [ben, "Loud Heron"]] as const) {
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id, anonymous_name } })
  }
  const said = await db.chat_messages.create({
    data: { chat_group_id: group.id, user_id: ana, content: "the queue is long" },
    select: { id: true },
  })
  await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: ben, content: "agreed" } })
  await db.moderation_flags.create({
    data: { message_id: said.id, chat_group_id: group.id, user_id: ana, source: "user_report", confidence: 1, categories: {} },
  })
  return group.id
}

beforeAll(async () => {
  host = await makeUser(testId("dcni-host"), "organizer")
  owner = await makeUser(testId("dcni-owner"), "organizer")
  admin = await makeUser(testId("dcni-admin"), "app_admin")
  ana = await makeUser(testId("dcni-ana"))
  ben = await makeUser(testId("dcni-ben"))
  colleague = await makeUser(testId("dcni-colleague"), "organizer")
  stranger = await makeUser(testId("dcni-stranger"))
  users.push(host, owner, admin, ana, ben, colleague, stranger)
  await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

  const hostOrg = await org("dcni-host-org", host)
  await db.organisation_members.create({ data: { org_id: hostOrg, user_id: colleague, role: "staff" } })
  const venueOrg = await org("dcni-venue-org", owner)
  const venue = await db.venues.create({
    data: {
      name: testId("dcni-venue"),
      latitude: 12.9,
      longitude: 77.5,
      owner_org_id: venueOrg,
      claimed_at: new Date(Date.now() - 30 * DAY),
    },
    select: { id: true },
  })
  venues.push(venue.id)

  eventA = await makeEvent(host)
  eventB = await makeEvent(host)
  events.push(eventA, eventB)
  groupA = await room(eventA, hostOrg, venue.id)
  await room(eventB, hostOrg, venue.id)
  // A colleague holding the room with the host: not moderated here (SCRUM-466).
  await db.chat_group_members.create({ data: { chat_group_id: groupA, user_id: colleague, role: "admin" } })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.events.updateMany({ where: { id: { in: events } }, data: { venue_id: null } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

type Feed = {
  messages: Array<{ user: { id: string; anonymousName: string | null } }>
  members: Array<{ userId: string; anonymousName: string | null; role: string }>
}
type Flags = { data: { flags: Array<{ userId: string; anonymousName: string | null }> } }

async function feed(eventId: string): Promise<{ wire: string; body: Feed }> {
  const res = await roomFeed(new Request(`http://localhost/api/events/${eventId}/chat/messages`), {
    params: Promise.resolve({ id: eventId }),
  })
  expect(res.status).toBe(200)
  const wire = await res.text()
  return { wire, body: JSON.parse(wire) as Feed }
}

async function flags(eventId: string): Promise<{ wire: string; body: Flags }> {
  const res = await flagQueue(new NextRequest(`http://localhost/api/events/${eventId}/chat/moderation`), {
    params: Promise.resolve({ id: eventId }),
  })
  expect(res.status).toBe(200)
  const wire = await res.text()
  return { wire, body: JSON.parse(wire) as Flags }
}

const patch = (eventId: string, ref: string, action: string) =>
  moderateMember(
    new NextRequest(`http://localhost/api/events/${eventId}/chat/members/${ref}`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id: eventId, userId: ref }) }
  )

const status = async (userId: string) =>
  (
    await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: groupA, user_id: userId } },
      select: { status: true },
    })
  ).status

const memberRow = (userId: string) =>
  db.chat_group_members.findUniqueOrThrow({
    where: { chat_group_id_user_id: { chat_group_id: groupA, user_id: userId } },
    select: { status: true, banned_at: true, banned_by: true, muted_by: true },
  })

/** A handle with one character changed in the middle: GCM refuses it. */
function tampered(handle: string): string {
  const i = Math.floor(handle.length / 2)
  return handle.slice(0, i) + (handle[i] === "A" ? "B" : "A") + handle.slice(i + 1)
}

/** The audit write is fire-and-forget; wait for the row the route promised. */
async function audited(action: string, resourceId: string, eventId: string) {
  for (let i = 0; i < 50; i++) {
    const row = await db.audit_logs.findFirst({
      where: { action, resource_id: resourceId, details: { path: ["eventId"], equals: eventId } },
    })
    if (row) return row
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`no ${action} audit row for ${eventId}`)
}

describe.each([
  ["an organiser", "organizer" as const, () => host],
  ["a venue owner", "venue_owner" as const, () => owner],
])("%s reading the room", (_label, role, who) => {
  beforeEach(() => as(role, who()))

  it("carries no attendee's account id anywhere in the feed", async () => {
    const { wire } = await feed(eventA)
    expect(wire).not.toContain(ana)
    expect(wire).not.toContain(ben)
  })

  it("names each attendee by this room's handle, the same in messages and members", async () => {
    const { body } = await feed(eventA)
    const handle = roomHandle(eventA, ana)
    const said = body.messages.find((m) => m.user.anonymousName === "Quiet Otter")
    const member = body.members.find((m) => m.anonymousName === "Quiet Otter")
    expect(said?.user.id).toBe(handle)
    expect(member?.userId).toBe(handle)
    expect(resolveUserRef(handle)).toEqual({ userId: ana, eventId: eventA })
  })

  it("gives the same person an unrelated handle in another room", async () => {
    const a = (await feed(eventA)).body.members.find((m) => m.anonymousName === "Quiet Otter")?.userId
    const b = (await feed(eventB)).body.members.find((m) => m.anonymousName === "Quiet Otter")?.userId
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it("carries no attendee's account id in the flag queue", async () => {
    const { wire, body } = await flags(eventA)
    expect(wire).not.toContain(ana)
    expect(body.data.flags[0].userId).toBe(roomHandle(eventA, ana))
    // The reviewer is a staff account id: not the host's to have.
    expect(body.data.flags[0]).not.toHaveProperty("reviewedBy")
  })
})

describe("moderating by handle", () => {
  beforeEach(() => as("organizer", host))

  it("mutes the person behind this room's handle", async () => {
    const res = await patch(eventA, roomHandle(eventA, ben), "mute")
    expect(res.status).toBe(200)
    expect(await status(ben)).toBe("muted")
    expect((await patch(eventA, roomHandle(eventA, ben), "unmute")).status).toBe(200)
    expect(await status(ben)).toBe("active")
  })

  it("answers a raw account id from a host as an unknown person, and writes nothing", async () => {
    const res = await patch(eventA, ana, "ban")
    expect(res.status).toBe(404)
    expect(await status(ana)).toBe("active")
  })

  it("answers another room's handle the same way", async () => {
    const res = await patch(eventA, roomHandle(eventB, ana), "ban")
    expect(res.status).toBe(404)
    expect(await status(ana)).toBe("active")
  })
})

describe("the ban and mute route, by handle (SCRUM-517)", () => {
  it("bans and unbans the person behind the handle, and records who did it", async () => {
    as("organizer", host)
    expect((await patch(eventA, roomHandle(eventA, ben), "ban")).status).toBe(200)
    const banned = await memberRow(ben)
    expect(banned.status).toBe("banned")
    expect(banned.banned_at).toBeInstanceOf(Date)
    expect(banned.banned_by).toBe(host)

    expect((await patch(eventA, roomHandle(eventA, ben), "unban")).status).toBe(200)
    expect(await memberRow(ben)).toMatchObject({ status: "active", banned_at: null, banned_by: null })
  })

  it("lets a venue owner mute by handle", async () => {
    as("venue_owner", owner)
    expect((await patch(eventA, roomHandle(eventA, ben), "mute")).status).toBe(200)
    expect(await memberRow(ben)).toMatchObject({ status: "muted", muted_by: owner })
    expect((await patch(eventA, roomHandle(eventA, ben), "unmute")).status).toBe(200)
  })

  it.each([
    ["a tampered handle", () => tampered(roomHandle(eventA, ana))],
    ["a truncated handle", () => roomHandle(eventA, ana).slice(0, -6)],
    ["a handle for somebody who is not in this room", () => roomHandle(eventA, stranger)],
  ])("answers %s with 404 and writes nothing", async (_label, ref) => {
    as("organizer", host)
    const before = await memberRow(ana)
    const res = await patch(eventA, ref(), "ban")
    expect(res.status).toBe(404)
    expect(await memberRow(ana)).toEqual(before)
  })

  it("still refuses a colleague who holds the room, named by handle (SCRUM-466)", async () => {
    as("organizer", host)
    const res = await patch(eventA, roomHandle(eventA, colleague), "ban")
    expect(res.status).toBe(409)
    expect(await status(colleague)).toBe("active")
  })
})

describe("the audit log a host's organisation reads", () => {
  it("names the person a host moderated by each room's handle, never the account id", async () => {
    as("organizer", host)
    for (const eventId of [eventA, eventB]) {
      expect((await patch(eventId, roomHandle(eventId, ana), "mute")).status).toBe(200)
      expect((await patch(eventId, roomHandle(eventId, ana), "unmute")).status).toBe(200)
      await audited("chat.member_mute", ana, eventId)
    }

    const log = await getAuditLog({ action: "chat.member_mute" })
    const mine = log.entries.filter((e) => e.resource === "chat_group_member")
    const ids = mine.map((e) => e.resourceId)
    expect(ids).toEqual(expect.arrayContaining([roomHandle(eventA, ana), roomHandle(eventB, ana)]))
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(log)).not.toContain(ana)
  })

  it("keeps the account id for the admin", async () => {
    as("app_admin", admin)
    const log = await getAuditLog({ action: "chat.member_mute" })
    expect(log.entries.map((e) => e.resourceId)).toContain(ana)
  })
})

describe("an admin", () => {
  beforeEach(() => as("app_admin", admin))

  it("moderates by handle too, and a forged one is nobody", async () => {
    expect((await patch(eventA, roomHandle(eventA, ben), "mute")).status).toBe(200)
    expect(await status(ben)).toBe("muted")
    expect((await patch(eventA, roomHandle(eventA, ben), "unmute")).status).toBe(200)

    const before = await memberRow(ana)
    expect((await patch(eventA, tampered(roomHandle(eventA, ana)), "ban")).status).toBe(404)
    expect(await memberRow(ana)).toEqual(before)
  })

  it("reads the real account id in the flag queue", async () => {
    const { body } = await flags(eventA)
    expect(body.data.flags[0].userId).toBe(ana)
    expect(body.data.flags[0]).toHaveProperty("reviewedBy")
  })

  it("still reads real ids, and moderates by one", async () => {
    const { body } = await feed(eventA)
    expect(body.members.map((m) => m.userId)).toEqual(expect.arrayContaining([ana, ben]))
    expect((await patch(eventA, ben, "mute")).status).toBe(200)
    expect(await status(ben)).toBe("muted")
    expect((await patch(eventA, ben, "unmute")).status).toBe(200)
  })
})
