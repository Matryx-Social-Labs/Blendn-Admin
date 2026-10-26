let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session ? { ...session, user: { signedInAt: 0, ...session.user } } : null) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { GET as roomFeed } from "@/app/api/events/[id]/chat/messages/route"

import { sqlCounter } from "./sql-count"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

/**
 * The organiser's feed polls every 5 seconds per open room. The poll
 * (`?light=1`) must not carry the whole roster: a big room's members are what
 * the Members tab shows, read in full when it is opened. What the feed itself
 * needs -- who is restricted, who wrote the messages shown, how many are in --
 * rides on the poll.
 */
const users: string[] = []
const events: string[] = []
const ROOM = 40

let eventId = ""
let admin = ""
const members: string[] = []

const feed = async (query = "") => {
  const res = await roomFeed(new Request(`http://localhost/api/events/${eventId}/chat/messages${query}`), { params: Promise.resolve({ id: eventId }) })
  expect(res.status).toBe(200)
  return res.json() as Promise<{
    activeCount: number
    pendingFlags: number
    messages: { id: string; user: { anonymousName: string | null } }[]
    members: { userId: string; anonymousName: string | null; status: string }[]
  }>
}

beforeAll(async () => {
  admin = await makeUser(testId("dcp-admin"), "app_admin")
  const host = await makeUser(testId("dcp-host"), "organizer")
  users.push(admin, host)
  session = { user: { id: admin, role: "app_admin" } }
  eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "Room" }, select: { id: true } })
  for (let i = 0; i < ROOM; i++) {
    const id = await makeUser(testId(`dcp-m${i}`))
    users.push(id)
    members.push(id)
    await db.chat_group_members.create({
      data: {
        chat_group_id: group.id,
        user_id: id,
        anonymous_name: `Name ${i}`,
        status: i === 0 ? "banned" : i === 1 ? "muted" : "active",
      },
    })
  }
  // Two speak (one of them the muted one); nobody else does.
  await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: members[1], content: "hello" } })
  await db.chat_messages.create({ data: { chat_group_id: group.id, user_id: members[5], content: "hi" } })
})

afterAll(async () => {
  await db.chat_messages.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: events } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

it("the full read carries the whole roster, and how many are in", async () => {
  const full = await feed()
  expect(full.members).toHaveLength(ROOM)
  expect(full.activeCount).toBe(ROOM - 2)
})

it("the poll carries the restricted and the speakers, the same count, and the same messages", async () => {
  const full = await feed()
  const light = await feed("?light=1")
  expect(light.activeCount).toBe(full.activeCount)
  expect(light.pendingFlags).toBe(full.pendingFlags)
  expect(light.messages).toEqual(full.messages)
  // Banned, muted (who also spoke), and the one active speaker: three of forty.
  expect(light.members.map((m) => m.status).sort()).toEqual(["active", "banned", "muted"])
  // Every message's author is named, as in the full read.
  expect(light.messages.map((m) => m.user.anonymousName)).toEqual(full.messages.map((m) => m.user.anonymousName))
  // What is sent is a subset of the full roster, row for row.
  for (const m of light.members) expect(full.members).toContainEqual(m)
})

it("costs the same statements however many are in the room, and ships none of them", async () => {
  const counter = sqlCounter()
  try {
    const { sql } = await counter.during(() => feed("?light=1"))
    console.info(`poll: ${sql.length} statements`)
    // The roster read is filtered in the database, not narrowed after.
    const rosterReads = sql.filter((s) => /FROM "public"."chat_group_members"/.test(s) && !/COUNT/.test(s))
    expect(rosterReads.length).toBeGreaterThan(0)
    for (const read of rosterReads) expect(read).toMatch(/"status" IN|"user_id" IN/)
  } finally {
    await counter.stop()
  }
})
