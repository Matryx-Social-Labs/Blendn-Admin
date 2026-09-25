import { NextRequest } from "next/server"

/*
 * A board post gets the room's checks before anyone reads it, and its author
 * can take it back (SCRUM-301).
 *
 * Found on staging: `POST /events/{id}/board` stored whatever it was given —
 * no keyword, contact-detail or OpenAI check, where a room message gets all
 * three before it is stored — and nothing, author's or moderator's, could
 * remove a post afterwards. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const postRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const categories: string[] = []
let eventId = ""
let author = { id: "", token: "" }
let stranger = { id: "", token: "" }

afterAll(async () => {
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await cleanup(users, events)
  await closeDb()
})

/** Going, with a profile complete enough to post (name, age, two interests, an intent). */
async function poster(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  const born = new Date()
  born.setFullYear(born.getFullYear() - 30)
  await db.profiles.create({ data: { id, name: `Test ${label}`, date_of_birth: born, intent_default: ["friendship"] } })
  await db.user_interests.createMany({ data: categories.map((category_id) => ({ user_id: id, category_id })) })
  await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status: "going" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const req = (method: string, url: string, token: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const post = (token: string, body: string) =>
  boardRoute.POST(req("POST", `/api/mobile/events/${eventId}/board`, token, { kind: "seeking", body }), {
    params: Promise.resolve({ eventId }),
  })

const withdraw = (token: string, postId: string) =>
  postRoute.DELETE(req("DELETE", `/api/mobile/events/${eventId}/board/${postId}`, token), {
    params: Promise.resolve({ eventId, postId }),
  })

beforeAll(async () => {
  const host = await makeUser(testId("bmw-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
  const start = new Date(Date.now() + 24 * 3600_000)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
  for (const n of [1, 2]) {
    const slug = testId(`bmw-cat-${n}`)
    categories.push((await db.categories.create({ data: { name: slug, slug }, select: { id: true } })).id)
  }
  author = await poster("bmw-author")
  stranger = await poster("bmw-stranger")
})

describe("a post gets the room's checks first", () => {
  it("stores an ordinary post", async () => {
    const res = await post(author.token, "anyone going from Indiranagar?")
    expect(res.status).toBe(201)
  })

  it("refuses a phone number, says why, and stores nothing", async () => {
    const res = await post(author.token, "call me on 98765 43210 for a lift")
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/phone number/i)
    expect(await db.board_posts.count({ where: { event_id: eventId, body: { contains: "98765" } } })).toBe(0)
  })

  it("refuses abuse, without teaching the filter, and stores nothing", async () => {
    const res = await post(author.token, "you are a retard")
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe("This can't go on the board.")
    expect(await db.board_posts.count({ where: { event_id: eventId, body: { contains: "retard" } } })).toBe(0)
  })
})

describe("the author can take a post back", () => {
  it("withdraws their own, and the board stops listing it", async () => {
    const created = (await (await post(author.token, "spare seat to the venue")).json()) as { data: { id: string } }
    const res = await withdraw(author.token, created.data.id)
    expect(res.status).toBe(200)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: created.data.id } })).deleted_at).not.toBeNull()
    const listed = (await (await boardRoute.GET(req("GET", `/api/mobile/events/${eventId}/board`, author.token), { params: Promise.resolve({ eventId }) })).json()) as { data: { posts: { id: string }[] } }
    expect(listed.data.posts.map((p) => p.id)).not.toContain(created.data.id)
  })

  it("cannot withdraw somebody else's — a 404, and the post stands", async () => {
    const created = (await (await post(author.token, "sharing an auto after")).json()) as { data: { id: string } }
    expect((await withdraw(stranger.token, created.data.id)).status).toBe(404)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: created.data.id } })).deleted_at).toBeNull()
  })
})
