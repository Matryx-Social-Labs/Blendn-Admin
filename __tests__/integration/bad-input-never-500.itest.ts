import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative, sep } from "path"
import { NextRequest } from "next/server"

/*
 * A caller's bad input is a 4xx, never a 500 (SCRUM-430, SCRUM-433).
 *
 * Driven on staging-api (SCRUM-267): 18 of 68 dynamic mobile route-methods
 * answered 500 to an id that isn't a UUID — Postgres refuses the cast, and the
 * route's catch-all calls that a server error — and 27 of 44 body routes
 * answered 500 to a body that isn't JSON, because `request.json()` throws into
 * the same catch-all. `?cursor=zzz` did it to notifications. Each one is a
 * client's mistake reported as an outage, logged at ERROR beside the real ones.
 *
 * The routes are found on disk, so a route added tomorrow is covered the day it
 * lands. Against a fresh event, room and DM thread for every case:
 *   - each path parameter in turn is not a UUID, the others real rows, with an
 *     empty body and with one most schemas accept (a route that validates its
 *     body first would otherwise stop at the 400 before it meets the id);
 *   - one junk query value at a time on every GET, so none hides another;
 *   - a body that is not JSON, and one with the wrong types, on every route
 *     that reads a body.
 * Anything below 500 passes: which 4xx is each route's business. Where a 200
 * would itself be the defect — a default action taken on a garbage body — the
 * last block asserts the refusal and reads the row back.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
// Storage "configured", or the upload routes answer 503 before they read the
// body. Presigning is local signing, so nothing is ever sent to this endpoint.
process.env.TIGRIS_ENDPOINT = "http://127.0.0.1:9"
process.env.TIGRIS_ACCESS_KEY = "itest"
process.env.TIGRIS_SECRET_KEY = "itest"

const API = join(__dirname, "..", "..", "app", "api")
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
type Method = (typeof METHODS)[number]
const NOT_A_UUID = "not-a-uuid"
const NIL = "00000000-0000-4000-8000-000000000000"
const HUGE = "99999999999999999999"
const JUNK_QUERIES = [
  "?cursor=not-a-uuid",
  "?before=not-a-uuid",
  // Dates `Date.parse` accepts and Postgres refuses.
  "?cursor=0000-01-01",
  "?before=0000-01-01",
  "?limit=abc",
  "?limit=1.5",
  `?limit=${HUGE}`,
  "?limit=-5&page=2",
  "?offset=abc",
  "?offset=-5",
  `?offset=${HUGE}`,
  "?page=abc",
  `?page=${HUGE}`,
  "?status=nope",
  "?from=nope&to=nope",
]
/** Right shape, wrong types: a number where a token is hashed, a string where a uuid is cast. */
const WRONG_TYPES = JSON.stringify({ token: 123, password: 123, orgId: NOT_A_UUID, action: 123, status: 123, content: 123 })

type Route = { path: string; params: string[]; readsBody: boolean; mod: Partial<Record<Method, Handler>> }
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

function discover(dir = API, acc: Route[] = []): Route[] {
  // Sorted: the order cases run in is the same on every filesystem.
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) discover(full, acc)
    else if (entry === "route.ts") {
      const rel = relative(API, dir).split(sep).join("/")
      if (rel.includes("[...")) continue // NextAuth's own catch-all
      acc.push({
        path: `/api/${rel}`,
        params: [...rel.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]),
        readsBody: /\.json\(\)|\.text\(\)|\.formData\(\)|readJson\(|readOptionalJson\(/.test(readFileSync(full, "utf8")),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod: require(full),
      })
    }
  }
  return acc
}

const ROUTES = discover()
const pairs = (pick: (r: Route, m: Method) => boolean) =>
  ROUTES.flatMap((r) => METHODS.filter((m) => r.mod[m] && pick(r, m)).map((m) => ({ r, m })))
const route = (path: string) => ROUTES.find((r) => r.path === path)!

const users: string[] = []
const events: string[] = []
const people = { me: "", other: "", admin: "" }
/** A real row for each parameter name, so the one bad parameter is the one a route meets. */
const real: Record<string, string> = {}
let mobileToken = ""

beforeAll(async () => {
  const me = await makeUser(testId("bad-input-me"))
  const other = await makeUser(testId("bad-input-other"))
  const admin = await makeUser(testId("bad-input-admin"), "app_admin")
  users.push(me, other, admin)
  await onboard(me, other)
  Object.assign(people, { me, other, admin })
  mobileToken = signAccessToken(me, `${me}@itest.invalid`)
  // With an email, as a real session has: routes that read its domain reach the input.
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin", email: `${admin}@itest.invalid` } })
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("no network from this test"))
})

/*
 * A fresh event, room and DM thread for every case. Some cases change the world
 * they meet (a DELETE removes the event, a leave closes the thread), and every
 * case after one of those would stop at a 404 before reaching its input.
 */
beforeEach(async () => {
  const { me, other, admin } = people
  const eventId = await makeEvent(admin)
  events.push(eventId)
  await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: me })
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
  await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: me } })
  const [user1_id, user2_id] = [me, other].sort()
  await db.private_messages.deleteMany({ where: { conversation: { user1_id, user2_id } } })
  await db.private_conversations.deleteMany({ where: { user1_id, user2_id } })
  const conversation = await db.private_conversations.create({ data: { user1_id, user2_id } })
  Object.assign(real, { eventId, id: eventId, chatGroupId: group.id, conversationId: conversation.id, userId: other })
  ;(global.fetch as jest.Mock).mockClear()
})

// Nothing here should reach the outside world: not even a failure a route swallows.
afterEach(() => expect(global.fetch).not.toHaveBeenCalled())

afterAll(async () => {
  await db.event_rsvps.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_group_members.deleteMany({ where: { user_id: { in: users } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function call(r: Route, m: Method, params: Record<string, string>, query = "", body?: string) {
  const url = `http://localhost${r.path.replace(/\[([^\]]+)\]/g, (_, p) => params[p])}${query}`
  const req = new NextRequest(url, {
    method: m,
    headers: { authorization: `Bearer ${mobileToken}`, "content-type": "application/json" },
    body,
  })
  const res = await r.mod[m]!(req, { params: Promise.resolve(params) })
  return res.status
}

/** Real rows for every parameter. A profile route is the caller's own profile. */
const withReal = (r: Route) =>
  Object.fromEntries(
    r.params.map((p) => [p, p === "userId" && r.path.includes("/profiles/") ? people.me : real[p] ?? NIL])
  )

/** One body that most route schemas accept, so a bad id is what the route meets first. */
const accepted = () =>
  JSON.stringify({
    action: "accept", emoji: "👍", content: "hello", text: "hello", body: "hello", message: "hello",
    type: "text", kind: "chat", reason: "spam", description: "fixture", messageType: "group",
    rating: 4, issue: "none", status: "going", optionId: NIL,
    userId: people.other, toUserId: people.other, latitude: 12.97, longitude: 77.59, accuracy: 10,
  })

describe("an empty cursor is no cursor", () => {
  // `?before=` was the first page before the cursor checks, and still is.
  it.each([
    "/api/mobile/chat/groups/[chatGroupId]/messages",
    "/api/mobile/conversations/[conversationId]/messages",
    "/api/mobile/notifications",
  ])("GET %s?before=&cursor=", async (path) => {
    const r = route(path)
    expect(await call(r, "GET", withReal(r), "?before=&cursor=")).toBe(200)
  })
})

describe("a path parameter that is not a UUID", () => {
  type Case = { r: Route; m: Method; p: string; body: "none" | "empty" | "accepted" }
  const cases: Case[] = pairs((r) => r.params.length > 0).flatMap(({ r, m }) =>
    r.params.flatMap((p): Case[] =>
      m === "GET" ? [{ r, m, p, body: "none" }] : (["empty", "accepted"] as const).map((body) => ({ r, m, p, body }))
    )
  )

  it.each(cases.map((c) => [`${c.m} ${c.r.path} with ${c.p}=${NOT_A_UUID}, body ${c.body}`, c]))(
    "%s",
    async (_, { r, m, p, body }) => {
      const payload = body === "none" ? undefined : body === "empty" ? "{}" : accepted()
      expect(await call(r, m, { ...withReal(r), [p]: NOT_A_UUID }, "", payload)).toBeLessThan(500)
    }
  )
})

describe("one junk query value on a GET", () => {
  const cases = pairs((_, m) => m === "GET").flatMap((c) => JUNK_QUERIES.map((q) => ({ ...c, q })))

  it.each(cases.map((c) => [`GET ${c.r.path}${c.q}`, c]))("%s", async (_, { r, m, q }) => {
    expect(await call(r, m, withReal(r), q)).toBeLessThan(500)
  })
})

/** Accepted, except every free-text field carries a NUL, which Postgres text cannot hold (SCRUM-434). */
const withNul = () =>
  JSON.stringify({
    ...JSON.parse(accepted()),
    ...Object.fromEntries(
      ["content", "text", "body", "message", "reason", "description", "token", "password", "email", "refreshToken", "pushToken"].map(
        (k) => [k, "a\u0000b"]
      )
    ),
  })

describe("a body that is not JSON, has the wrong types, or carries a NUL", () => {
  const cases = pairs((r, m) => m !== "GET" && r.readsBody).flatMap((c) => [
    { ...c, what: "not JSON", body: () => '{"a":' },
    { ...c, what: "the wrong types", body: () => WRONG_TYPES },
    { ...c, what: "a NUL in its text", body: withNul },
    { ...c, what: "nested 5,000 deep", body: () => "[".repeat(5000) + "]".repeat(5000) },
  ])

  it.each(cases.map((c) => [`${c.m} ${c.r.path}, ${c.what}`, c]))("%s", async (_, { r, m, body }) => {
    expect(await call(r, m, withReal(r), "", body())).toBeLessThan(500)
  })
})

describe("a body that is not JSON never takes the default action", () => {
  it("does not RSVP you as going", async () => {
    const r = route("/api/mobile/events/[eventId]/rsvp")
    expect(await call(r, "POST", withReal(r), "", '{"status":"not_go')).toBe(400)
    expect(await db.event_rsvps.count({ where: { event_id: real.eventId, user_id: people.me } })).toBe(0)
  })

  it("does not reveal you", async () => {
    const r = route("/api/mobile/conversations/[conversationId]/reveal")
    expect(await call(r, "POST", withReal(r), "", '{"ask":true')).toBe(400)
    const row = await db.private_conversations.findUniqueOrThrow({ where: { id: real.conversationId } })
    expect([row.user1_revealed, row.user2_revealed, row.user1_reveal_requested, row.user2_reveal_requested]).toEqual([false, false, false, false])
  })

  it("does not close the thread", async () => {
    const r = route("/api/mobile/conversations/[conversationId]/leave")
    expect(await call(r, "POST", withReal(r), "", '{"action":"block"')).toBe(400)
    const row = await db.private_conversations.findUniqueOrThrow({ where: { id: real.conversationId } })
    expect(row.closed_at).toBeNull()
  })

  it("does not mark every notification read", async () => {
    const note = await db.notifications.create({
      data: { user_id: people.me, kind: "announcement", title: "t", body: "b" },
    })
    const r = route("/api/mobile/notifications/read")
    expect(await call(r, "POST", withReal(r), "", '{"ids":[')).toBe(400)
    expect((await db.notifications.findUniqueOrThrow({ where: { id: note.id } })).read_at).toBeNull()
  })

  it("still takes it for no body at all", async () => {
    const r = route("/api/mobile/conversations/[conversationId]/leave")
    expect(await call(r, "POST", withReal(r), "", "")).toBe(200)
  })
})

describe("a NUL in a dashboard search query", () => {
  // The mobile API refuses %00 in middleware (nul-byte-refused.test.ts); these
  // routes are not behind it, and a NUL cannot match a row anyway (SCRUM-434).
  // (`/api/search` answers { hits: [] } for any failure, so it never 500s.)
  it.each(["/api/search", "/api/leads/export"])("GET %s?q=%00", async (path) => {
    const r = route(path)
    expect(await call(r, "GET", withReal(r), "?q=a%00b")).toBeLessThan(500)
  })
})
