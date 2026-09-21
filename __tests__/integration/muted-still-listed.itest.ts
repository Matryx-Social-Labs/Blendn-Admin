import { NextRequest } from "next/server"

/*
 * A mute silences; it does not banish (SCRUM-178).
 *
 * Driven on Android: Arjun muted Mystic Unicorn from the Members tab and the
 * room vanished from Ananya's Banter — Live now and Recent both; unmute and
 * it was back. `GET /chat/groups` listed only `active` memberships in `active`
 * rooms, while the room itself still let a muted member read. Banned and
 * left are removals and stay out; an archived room is over and stays out.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  if (events.length) await db.chat_groups.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function list(userId: string) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const res = await route.GET(
    new NextRequest("http://localhost/api/mobile/chat/groups", {
      headers: { authorization: `Bearer ${signAccessToken(userId, email)}` },
    })
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  return body.data.groups as Array<{ id: string; status: string; membership: { status: string } }>
}

it("lists a muted membership and a locked room, and leaves banned, left and archived out", async () => {
  const host = await makeUser(testId("msl-host"), "organizer")
  const me = await makeUser(testId("msl-me"))
  users.push(host, me)

  const rooms: Record<string, string> = {}
  for (const [key, groupStatus, memberStatus] of [
    ["muted", "active", "muted"],
    ["locked", "locked", "active"],
    ["plain", "active", "active"],
    ["banned", "active", "banned"],
    ["left", "active", "left"],
    ["archived", "archived", "active"],
  ] as const) {
    const eventId = await makeEvent(host)
    events.push(eventId)
    const group = await db.chat_groups.create({
      data: { event_id: eventId, name: key, status: groupStatus },
      select: { id: true },
    })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: me, status: memberStatus, anonymous_name: "Quiet Heron" },
    })
    rooms[key] = group.id
  }

  const groups = await list(me)
  const byId = new Map(groups.map((g) => [g.id, g]))

  expect(byId.get(rooms.muted)?.membership.status).toBe("muted")
  expect(byId.get(rooms.locked)?.status).toBe("locked")
  expect(byId.get(rooms.plain)).toMatchObject({ status: "active", membership: { status: "active" } })
  expect(byId.has(rooms.banned)).toBe(false)
  expect(byId.has(rooms.left)).toBe(false)
  expect(byId.has(rooms.archived)).toBe(false)
  expect(groups).toHaveLength(3)
})
