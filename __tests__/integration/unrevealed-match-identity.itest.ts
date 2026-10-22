import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { maySeeIdentity } from "@/lib/identity"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard } from "./helpers"

/**
 * A match keeps its pseudonym until the other person reveals (SCRUM-752).
 *
 * The inbox sends the raw `otherUser.id` beside a pseudonym, so the unscoped
 * identity gate is what stands between that id and a real name: a mutual like
 * or an open conversation used to open it, which skipped the reveal with one
 * profile read. Now the like and the conversation identify someone only once
 * THEY have revealed to the viewer (`mayShowRealName`); a room-level reveal, a
 * friend who opted in, and a conversation that never was pseudonymous still do.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const profile = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const userCard = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>

const users: string[] = []
const events: string[] = []

interface Person {
  id: string
  token: string
}

const REAL = "Priya Raman"
const PHOTO = "https://cdn.itest.invalid/priya.jpg"
const BLUR = "https://cdn.itest.invalid/priya-blur.jpg"

async function person(label: string, name = "Someone"): Promise<Person> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, bio: `bio of ${name}`, photos: [PHOTO], blur_photo: BLUR } })
  await db.user.update({ where: { id }, data: { name, image: PHOTO } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function get(handler: Handler, base: string, as: Person, userId: string) {
  const res = await handler(
    new NextRequest(`http://localhost${base}/${userId}`, { headers: { authorization: `Bearer ${as.token}` } }),
    { params: Promise.resolve({ userId }) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}
const profileOf = (as: Person, id: string) => get(profile.GET as Handler, "/api/mobile/profiles", as, id)
const cardOf = (as: Person, id: string) => get(userCard.GET as Handler, "/api/mobile/users", as, id)

/** The pair's match; `theirs` is whether `them` has revealed to `viewer`, `mine` the reverse. */
async function match(viewer: Person, them: Person, o: { theirs?: boolean; mine?: boolean } = {}) {
  const [user1_id, user2_id] = conversationPair(viewer.id, them.id)
  const viewerIsFirst = user1_id === viewer.id
  const theirs = o.theirs ?? false
  const mine = o.mine ?? false
  await db.private_conversations.create({
    data: {
      user1_id,
      user2_id,
      user1_pseudonym: "Otter",
      user2_pseudonym: "Heron",
      user1_revealed: viewerIsFirst ? mine : theirs,
      user2_revealed: viewerIsFirst ? theirs : mine,
    },
  })
}

async function revealTo(viewer: Person, them: Person) {
  const [user1_id, user2_id] = conversationPair(viewer.id, them.id)
  await db.private_conversations.update({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    data: user1_id === them.id ? { user1_revealed: true } : { user2_revealed: true },
  })
}

/** The shape of an answer with the values taken out: same keys, same nesting. */
const shapeOf = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(shapeOf) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)])) : typeof v

async function attendTogether(a: Person, b: Person) {
  const host = await makeUser("umi-host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrence_id = await occurrenceOf(eventId)
  for (const p of [a, b]) {
    await db.event_check_ins.create({
      data: { user_id: p.id, event_id: eventId, occurrence_id, check_in_time: new Date(), status: "checked_in" },
    })
  }
  return eventId
}

afterAll(async () => {
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await cleanup(users, events)
  await closeDb()
})

describe("an unrevealed match is a stranger on the raw-id surfaces", () => {
  it("answers a profile read exactly as it answers a stranger, whatever they have revealed to the other side", async () => {
    const [viewer, heron, stranger] = [await person("umi-v", "Vee"), await person("umi-h", REAL), await person("umi-s", REAL)]
    // The viewer has revealed to them; they have not revealed to the viewer.
    await match(viewer, heron, { mine: true })

    const [m, s] = [await profileOf(viewer, heron.id), await profileOf(viewer, stranger.id)]
    expect(m.status).toBe(200)
    expect(m.body.data).toMatchObject({ name: "Attendee" })
    expect(shapeOf(m.body)).toEqual(shapeOf(s.body))
    const wire = JSON.stringify(m.body)
    for (const secret of [REAL, PHOTO, "bio of"]) expect(wire).not.toContain(secret)
    expect(m.body.data).not.toHaveProperty("friend")

    const [mc, sc] = [await cardOf(viewer, heron.id), await cardOf(viewer, stranger.id)]
    expect(mc.body.data).toMatchObject({ identityVisible: false, name: "Attendee" })
    expect(shapeOf(mc.body)).toEqual(shapeOf(sc.body))
  })

  it("does not let a mutual like identify them either", async () => {
    const [viewer, heron] = [await person("umi-lv", "Vee"), await person("umi-lh", REAL)]
    const eventId = await attendTogether(viewer, heron)
    await db.event_likes.createMany({
      data: [
        { event_id: eventId, liker_id: viewer.id, liked_id: heron.id },
        { event_id: eventId, liker_id: heron.id, liked_id: viewer.id },
      ],
    })
    await match(viewer, heron)
    expect(await maySeeIdentity(viewer.id, heron.id)).toBe(false)
    expect((await profileOf(viewer, heron.id)).body.data.name).toBe("Attendee")
  })

  it("names them once they reveal, and gives the friend offer only then", async () => {
    const [viewer, heron] = [await person("umi-rv", "Vee"), await person("umi-rh", REAL)]
    await match(viewer, heron)
    expect((await profileOf(viewer, heron.id)).body.data.name).toBe("Attendee")

    await revealTo(viewer, heron)
    const after = (await profileOf(viewer, heron.id)).body.data
    expect(after).toMatchObject({ name: REAL, image: PHOTO, profile: { bio: `bio of ${REAL}`, photos: [PHOTO] } })
    // Only they have revealed: matched, not yet both.
    expect(after.friend).toEqual({ state: "none", canAdd: false })
    expect((await cardOf(viewer, heron.id)).body.data).toMatchObject({ identityVisible: true, name: REAL })
  })

  it("keeps a pseudonym who is already your friend from showing a friend state", async () => {
    const [viewer, heron] = [await person("umi-fv", "Vee"), await person("umi-fh", REAL)]
    await match(viewer, heron)
    const [user1_id, user2_id] = conversationPair(viewer.id, heron.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
    const res = (await profileOf(viewer, heron.id)).body.data
    expect(res.name).toBe("Attendee")
    expect(res).not.toHaveProperty("friend")
  })

  it("still identifies through everything that is not a match's pseudonym", async () => {
    const [viewer, revealedInRoom, friend, requested] = [
      await person("umi-xv", "Vee"),
      await person("umi-x1", REAL),
      await person("umi-x2", REAL),
      await person("umi-x3", REAL),
    ]
    // A room-level reveal at an event the viewer was at, on top of an unrevealed match.
    await match(viewer, revealedInRoom)
    const eventId = await attendTogether(viewer, revealedInRoom)
    await db.event_match_preferences.create({ data: { event_id: eventId, user_id: revealedInRoom.id, revealed: true } })
    expect((await profileOf(viewer, revealedInRoom.id)).body.data.name).toBe(REAL)

    // A friend who opted in to being recognised.
    await match(viewer, friend)
    const [user1_id, user2_id] = conversationPair(viewer.id, friend.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
    await db.profiles.update({ where: { id: friend.id }, data: { friends_see_me_in_rooms: true } })
    expect((await profileOf(viewer, friend.id)).body.data.name).toBe(REAL)

    // A conversation that never was pseudonymous.
    const [a, b] = conversationPair(viewer.id, requested.id)
    await db.private_conversations.create({ data: { user1_id: a, user2_id: b } })
    expect((await profileOf(viewer, requested.id)).body.data.name).toBe(REAL)

  })
})
