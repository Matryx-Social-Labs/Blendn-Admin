import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET ??= "itest-profile-pseudonym-preview-secret-32-chars"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeEvent, makeUser, onboard } from "./helpers"

/**
 * SCRUM-1093 (task 14), through the real handlers on a migrated database:
 *
 * - `pseudonym` on `GET /users/:ref` and `GET /profiles/:ref` (SCRUM-1046): present exactly when the card names
 *   somebody by their room pseudonym, never for a real id, never as "Attendee", never the real name;
 * - `GET /me/preview` ("See as others do", SCRUM-1076): your own card in both room states, the same shape the room
 *   route answers, with nothing that depends on a viewer.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const usersRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profilesRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const previewRoute = require("@/app/api/mobile/me/preview/route") as typeof import("@/app/api/mobile/me/preview/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>

const users: string[] = []
const events: string[] = []

interface Person {
  id: string
  token: string
}

const REAL = "Priya Raman Iyer"

async function person(label: string, name: string): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({
    where: { id },
    data: { name, photos: [`https://img.invalid/${label}.jpg`], bio: "Weekend climber", location: "Toronto" },
  })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(handler: Handler, path: string, as: Person, params: Record<string, string> = {}) {
  const res = await handler(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${as.token}` } }), {
    params: Promise.resolve(params) as Promise<never>,
  })
  return { status: res.status, body: await res.json() }
}

const card = (as: Person, ref: string) => call(usersRoute.GET as Handler, `/api/mobile/users/${ref}`, as, { userId: ref })
const profile = (as: Person, ref: string) => call(profilesRoute.GET as Handler, `/api/mobile/profiles/${ref}`, as, { userId: ref })
const preview = (as: Person) => call(previewRoute.GET as Handler, "/api/mobile/me/preview", as)

/** An event's room with these people seated under these pseudonyms, joined in this order. */
async function room(seats: [Person, string][]) {
  const host = await makeUser("pp-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  for (const [i, [p, anonymous_name]] of seats.entries()) {
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: p.id, anonymous_name, joined_at: new Date(Date.now() - (seats.length - i) * 60_000) },
    })
  }
  return eventId
}

afterAll(async () => {
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

describe("pseudonym on the person card (SCRUM-1046)", () => {
  it("is the room pseudonym for somebody that room keeps anonymous, on both routes", async () => {
    const [viewer, them] = [await person("pp-v1", "Viewer"), await person("pp-t1", REAL)]
    const eventId = await room([[viewer, "Amber Fox"], [them, "Velvet Otter"]])
    const ref = roomHandle(eventId, them.id)

    const users = await card(viewer, ref)
    expect(users.status).toBe(200)
    expect(users.body.data).toMatchObject({ name: "Velvet Otter", pseudonym: "Velvet Otter", identityVisible: false })
    const profiles = await profile(viewer, ref)
    expect(profiles.body.data).toMatchObject({ name: "Velvet Otter", pseudonym: "Velvet Otter" })
    for (const body of [users.body, profiles.body]) expect(JSON.stringify(body)).not.toContain("Priya")
  })

  it("is absent, not 'Attendee', for somebody with no pseudonym in that room", async () => {
    const [viewer, them] = [await person("pp-v2", "Viewer"), await person("pp-t2", REAL)]
    const eventId = await room([[viewer, "Amber Fox"]])
    const ref = roomHandle(eventId, them.id)

    for (const res of [await card(viewer, ref), await profile(viewer, ref)]) {
      expect(res.body.data.name).toBe("Attendee")
      expect(res.body.data).not.toHaveProperty("pseudonym")
    }
  })

  it("is absent for a real id, even for a friend who sees the real name", async () => {
    const [viewer, them] = [await person("pp-v3", "Viewer"), await person("pp-t3", REAL)]
    await room([[them, "Velvet Otter"]])
    const [user1_id, user2_id] = conversationPair(viewer.id, them.id)
    await db.friendships.create({ data: { user1_id, user2_id } })

    const res = await card(viewer, them.id)
    expect(res.body.data).toMatchObject({ name: REAL, identityVisible: true })
    expect(res.body.data).not.toHaveProperty("pseudonym")
    expect((await profile(viewer, them.id)).body.data).not.toHaveProperty("pseudonym")
  })
})

describe("GET /me/preview (See as others do)", () => {
  it("before any room: the anonymous card reads Attendee with no pseudonym, the named one the first name", async () => {
    const me = await person("pp-me1", REAL)
    const res = await preview(me)
    expect(res.status).toBe(200)
    expect(res.body.data.pseudonym).toBeNull()
    expect(res.body.data.anonymous).toEqual({
      id: me.id,
      name: "Attendee",
      age: null,
      location: expect.anything(),
      isOwnProfile: false,
      identityVisible: false,
    })
    expect(res.body.data.named).toMatchObject({
      id: me.id,
      name: "Priya",
      photos: [`https://img.invalid/pp-me1.jpg`],
      bio: "Weekend climber",
      isOwnProfile: false,
      identityVisible: true,
    })
    // Nothing that is the owner's alone, and nothing that needs a viewer.
    for (const key of ["email", "connection", "friend", "sharedInterests", "tonight", "wave"]) expect(res.body.data.named).not.toHaveProperty(key)
    expect(res.body.data.named.stats).not.toHaveProperty("savedCount")
  })

  it("names the pseudonym of the room joined last, and the anonymous card is exactly the room's", async () => {
    const [me, viewer] = [await person("pp-me2", REAL), await person("pp-v4", "Viewer")]
    await room([[me, "Old Heron"]])
    const eventId = await room([[viewer, "Amber Fox"], [me, "Velvet Otter"]])

    const res = await preview(me)
    expect(res.body.data.pseudonym).toBe("Velvet Otter")
    const inRoom = await card(viewer, roomHandle(eventId, me.id))
    // Same fields, same values, except the id: the room echoes its handle.
    expect({ ...res.body.data.anonymous, id: "x" }).toEqual({ ...inRoom.body.data, id: "x" })
  })

  it("the named card is the room route's identified card, less what depends on the viewer", async () => {
    const [me, friend] = [await person("pp-me3", REAL), await person("pp-f3", "Friend")]
    const [user1_id, user2_id] = conversationPair(me.id, friend.id)
    await db.friendships.create({ data: { user1_id, user2_id } })

    const named = (await preview(me)).body.data.named
    const asFriend = (await card(friend, me.id)).body.data
    const viewerOnly = ["connection", "friend", "sharedInterests"]
    expect(Object.keys(named).sort()).toEqual(Object.keys(asFriend).filter((k) => !viewerOnly.includes(k)).sort())
    // A raw id names in full; a room by first name, which is what the preview shows.
    expect({ ...named, name: REAL }).toEqual(Object.fromEntries(Object.entries(asFriend).filter(([k]) => !viewerOnly.includes(k))))
  })

  it("is 401 without a token", async () => {
    const res = await previewRoute.GET(new NextRequest("http://localhost/api/mobile/me/preview"))
    expect(res.status).toBe(401)
  })
})
