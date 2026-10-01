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
  users.push(host, owner, admin, ana, ben)
  await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })

  const hostOrg = await org("dcni-host-org", host)
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
})

afterAll(async () => {
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

describe.each([
  ["organiser", "organizer" as const, () => host],
  ["venue owner", "venue_owner" as const, () => owner],
])("a %s reading the room", (_label, role, who) => {
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

describe("an admin", () => {
  beforeEach(() => as("app_admin", admin))

  it("still reads real ids, and moderates by one", async () => {
    const { body } = await feed(eventA)
    expect(body.members.map((m) => m.userId)).toEqual(expect.arrayContaining([ana, ben]))
    expect((await patch(eventA, ben, "mute")).status).toBe(200)
    expect(await status(ben)).toBe("muted")
    expect((await patch(eventA, ben, "unmute")).status).toBe(200)
  })
})
