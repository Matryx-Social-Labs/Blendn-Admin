import { NextRequest } from "next/server"

/*
 * A closed pair answers like a stranger on every route that takes a room
 * handle (SCRUM-1476). V and X matched in room A and one of them unmatched;
 * both are now in room B with a stranger S. Waves, likes and message requests
 * refused X's room-B handle (403 / 404) and served S's, so V could probe room
 * B's handles for the person from room A: the one refused was X. Room handles
 * exist to stop that link (SCRUM-371).
 *
 * Now V's call on X's handle equals V's call on S's: status, body, headers,
 * and the sender's stored rows and caps (the reason task 17 rejected a silent
 * drop: a refusal that stores no row is visible through the stored-row caps).
 * What X gets is what the pair already decided: no ping, no push, no
 * conversation reopened, no new request.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-closed-pair-stranger-secret-32-chars"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import * as socketServer from "@/lib/socket-server"
import * as push from "@/lib/push-notifications"
import { connectionCounts } from "@/lib/connection-metrics"
import { conversationPair } from "@/lib/conversations"
import { signAccessToken } from "@/lib/mobile-auth"
import { peek, resetMemoryStore } from "@/lib/rate-limit-store"
import { roomHandle } from "@/lib/room-handle"
import { waveCapFor } from "@/lib/waves"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const wavesRoute = require("@/app/api/mobile/events/[eventId]/waves/route") as typeof import("@/app/api/mobile/events/[eventId]/waves/route")
const likesRoute = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const MONTH_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
const users: string[] = []
const events: string[] = []
let roomA: string
let roomB: string
let occB: string
let groupB: string

async function person(label: string, opts: { fresh?: boolean } = {}): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  // Past the new-account caps unless a case is about them (W5; message requests' 3 a day).
  if (!opts.fresh) await db.user.update({ where: { id }, data: { createdAt: MONTH_AGO } })
  await db.chat_group_members.create({ data: { chat_group_id: groupB, user_id: id, anonymous_name: testId(`Zq ${label}`) } })
  await putInRoom({ eventId: roomB, occurrenceId: occB, userId: id })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/** What the caller sees: status, body, and every header. */
async function post(handler: unknown, path: string, as: Person, body: unknown, params: Record<string, string> = {}) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> }
  )
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.json() }
}

const wave = (from: Person, to: Person) =>
  post(wavesRoute.POST, `/api/mobile/events/${roomB}/waves`, from, { toUserId: roomHandle(roomB, to.id) }, { eventId: roomB })
const like = (from: Person, to: Person) =>
  post(likesRoute.POST, `/api/mobile/events/${roomB}/matches/likes`, from, { userId: roomHandle(roomB, to.id) }, { eventId: roomB })
const ask = (from: Person, ref: string) => post(requestsRoute.POST, "/api/mobile/message-requests", from, { recipientId: ref, message: "coffee?" })

/** V and X had a conversation in room A, and it closed: an unmatch. */
async function closePair(a: Person, b: Person) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  await db.private_conversations.create({
    data: { user1_id, user2_id, origin_event_id: roomA, closed_at: new Date(), closed_by: a.id, closed_reason: "unmatch" },
  })
}

const pairRows = (a: Person, b: Person) => {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  return db.private_conversations.findMany({ where: { user1_id, user2_id }, select: { closed_at: true } })
}

beforeAll(async () => {
  const host = await makeUser(testId("cps-host"), "organizer")
  users.push(host)
  roomA = await makeEvent(host)
  roomB = await makeEvent(host)
  events.push(roomA, roomB)
  occB = await occurrenceOf(roomB)
  groupB = (await db.chat_groups.create({ data: { event_id: roomB, name: "room" }, select: { id: true } })).id
}, 30_000)

beforeEach(() => {
  resetMemoryStore()
  jest.restoreAllMocks()
})

afterAll(async () => {
  await db.event_waves.deleteMany({ where: { OR: [{ from_id: { in: users } }, { to_id: { in: users } }] } })
  await db.event_likes.deleteMany({ where: { OR: [{ liker_id: { in: users } }, { liked_id: { in: users } }] } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.private_conversations.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

describe("waves: a closed pair's handle answers as a stranger's (SCRUM-1476)", () => {
  it("same status, body and headers; both stored; only the stranger is pinged", async () => {
    const [v, x, s] = [await person("cpw-v"), await person("cpw-x"), await person("cpw-s")]
    await closePair(x, v)
    const pings = jest.spyOn(socketServer, "emitRoomWave")
    const metBefore = (await connectionCounts(roomB)).connections

    const toX = await wave(v, x)
    const toS = await wave(v, s)

    expect(toX).toEqual(toS)
    expect(toS.status).toBe(200)
    expect(toS.body).toEqual({ success: true, data: { sent: true, mutual: false } })
    // Stored like any wave, so the sender's caps count it.
    const rows = await db.event_waves.findMany({ where: { from_id: v.id }, select: { event_id: true, to_id: true } })
    expect(rows.map((r) => r.to_id).sort()).toEqual([x.id, s.id].sort())
    // The ping goes to whoever's list shows the sender: S, never X.
    expect(pings.mock.calls.map(([to]) => to)).toEqual([s.id])
    // X waving back reopens nothing: still the one closed conversation, no new ping.
    expect((await wave(x, v)).body).toEqual({ success: true, data: { sent: true, mutual: false } })
    expect(await pairRows(v, x)).toEqual([{ closed_at: expect.any(Date) }])
    expect(pings.mock.calls.map(([to]) => to)).toEqual([s.id])
    // And the host's counts do not call an unmatched pair met here.
    expect((await connectionCounts(roomB)).connections).toBe(metBefore)
  })

  it("control for the host's counts: a pair that met here and closed afterwards still counts as met here", async () => {
    const [a, b] = [await person("cpk-a"), await person("cpk-b")]
    const before = (await connectionCounts(roomB)).connections
    await wave(a, b)
    const back = await wave(b, a)
    expect(back.body.data.mutual).toBe(true)
    const [user1_id, user2_id] = conversationPair(a.id, b.id)
    await db.private_conversations.update({ where: { user1_id_user2_id: { user1_id, user2_id } }, data: { closed_at: new Date() } })
    expect((await connectionCounts(roomB)).connections).toBe(before + 1)
  })

  it("the cap counts a wave at a closed pair exactly as one at a stranger: the next one is refused alike", async () => {
    // A new account: 5 a room an hour (W5).
    const v = await person("cpc-v", { fresh: true })
    const x = await person("cpc-x")
    const others = [await person("cpc-1"), await person("cpc-2"), await person("cpc-3"), await person("cpc-4"), await person("cpc-5")]
    await closePair(v, x)

    expect((await wave(v, x)).status).toBe(200)
    for (const o of others.slice(0, 4)) expect((await wave(v, o)).status).toBe(200)

    // Five stored, one of them at X: the sixth is the cap's 429, as after five strangers.
    expect(await waveCapFor(v.id, roomB)).toMatchObject({ cap: "room_hour" })
    const sixth = await wave(v, others[4])
    expect(sixth.status).toBe(429)
    expect(sixth.body.errorCode).toBe("RATE_LIMITED")
    // SELECT event_id, from_id, to_id FROM event_waves WHERE from_id = <V>
    const read = await db.$queryRaw<{ event_id: string; from_id: string; to_id: string }[]>`
      SELECT event_id::text, from_id, to_id FROM event_waves WHERE from_id = ${v.id}`
    expect(read).toHaveLength(5)
    expect(read.every((r) => r.event_id === roomB)).toBe(true)
    expect(read.map((r) => r.to_id)).toContain(x.id)
    console.log(`[read-back] waves from V: ${read.length} rows in room B, one to X: ${read.some((r) => r.to_id === x.id)}`)
  })

  it("someone who reported the sender is not pinged either; the sender's answer is a stranger's", async () => {
    const [v, c, s] = [await person("cpr-v"), await person("cpr-c"), await person("cpr-s")]
    await db.user_reports.create({ data: { reporter_id: c.id, reported_id: v.id, reason: "harassment" } })
    const pings = jest.spyOn(socketServer, "emitRoomWave")
    expect(await wave(v, c)).toEqual(await wave(v, s))
    expect(pings.mock.calls.map(([to]) => to)).toEqual([s.id])
  })
})

describe("likes: a closed pair's handle answers as a stranger's", () => {
  it("same answer, both stored; a like back opens nothing and pushes nothing", async () => {
    const [v, x, s] = [await person("cpl-v"), await person("cpl-x"), await person("cpl-s")]
    await closePair(v, x)
    const matches = jest.spyOn(push, "sendPushNotification")

    const toX = await like(v, x)
    const toS = await like(v, s)
    expect(toX).toEqual(toS)
    expect(toS).toMatchObject({ status: 200, body: { success: true, data: { mutual: false } } })
    const liked = await db.event_likes.findMany({ where: { liker_id: v.id }, select: { liked_id: true } })
    expect(liked.map((r) => r.liked_id).sort()).toEqual([x.id, s.id].sort())

    // X likes back: the reciprocal like is there, and the closed pair stays closed (`openIfMutual`: linked).
    expect((await like(x, v)).body).toEqual({ success: true, data: { mutual: false } })
    expect(await pairRows(v, x)).toEqual([{ closed_at: expect.any(Date) }])
    expect(matches).not.toHaveBeenCalled()
  })
})

describe("message requests: a closed pair's handle answers as a stranger's", () => {
  it("the same 201 shape; the stranger's is stored and pushed, X's holds a slot and reaches nobody", async () => {
    const [v, x, s] = [await person("cpm-v"), await person("cpm-x"), await person("cpm-s")]
    await closePair(x, v)
    const pushes = jest.spyOn(push, "sendPushNotification")

    const toX = await ask(v, roomHandle(roomB, x.id))
    const toS = await ask(v, roomHandle(roomB, s.id))
    const shape = (r: typeof toX) => ({
      status: r.status,
      headers: r.headers,
      keys: Object.keys(r.body.data?.request ?? {}).sort(),
      status_: r.body.data?.request?.status,
      message: r.body.data?.request?.message,
    })
    expect(shape(toX)).toEqual(shape(toS))
    expect(toX.status).toBe(201)
    // The ref echoed, never the id behind it, and a fresh id either way.
    expect(toX.body.data.request.recipientId).toBe(roomHandle(roomB, x.id))
    expect(toX.body.data.request.id).not.toBe(toS.body.data.request.id)

    expect(await db.message_requests.count({ where: { sender_id: v.id, recipient_id: s.id } })).toBe(1)
    expect(await db.message_requests.count({ where: { sender_id: v.id, recipient_id: x.id } })).toBe(0)
    // The silent answer holds a slot in the unanswered cap, as a real request does (`countSilentRequest`).
    expect(await peek(`mr:silent:${v.id}`)).toBe(1)
    expect(pushes.mock.calls.map(([p]) => p.userId)).toEqual([s.id])
  })

  it("a raw id for a closed pair is the silent 201 too (decided: the raw id names nobody new to the sender)", async () => {
    const [v, x] = [await person("cpi-v"), await person("cpi-x")]
    await closePair(v, x)
    const r = await ask(v, x.id)
    expect(r.status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: v.id, recipient_id: x.id } })).toBe(0)
  })

  it("somebody who can see who this is still hears 404, as before", async () => {
    const [v, x] = [await person("cpn-v"), await person("cpn-x")]
    await closePair(v, x)
    // X chose to be named in room B: V sees who this is, so the closed pair is no secret to V.
    await db.event_match_preferences.create({ data: { event_id: roomB, user_id: x.id, revealed: true } })
    const r = await ask(v, roomHandle(roomB, x.id))
    expect(r.status).toBe(404)
    expect(r.body.error).toBe("User not found")
  })
})
