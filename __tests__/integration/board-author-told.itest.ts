import { NextRequest } from "next/server"
import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * A board post's author is told when it is taken down against their will (SV9):
 * a `board_post_removed` push and bell row, and `board:postRemoved` on their own
 * `user:` room. Both takedowns tell: a moderator's removal and the automatic
 * check. Their own withdrawal does not, and nobody else hears it.
 */
type Msg = { to: string; data?: { type?: string } }
const sent = jest.fn(async (msgs: Msg[]) => msgs.map(() => ({ status: "ok", id: "t" })))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    sendPushNotificationsAsync(chunk: Msg[]) {
      return sent(chunk)
    }
  }
  return { Expo }
})
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session?.user ? { ...session, user: { signedInAt: 0, ...session.user } } : session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockCheck = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContent: (...a: unknown[]) => mockCheck(...a),
}))

import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { hideBoardPostIfFlagged } from "@/lib/board-access"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const postRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
let eventId = ""
const emitted: Array<{ room: string; event: string; payload: unknown }> = []

beforeAll(() => {
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = {
    to: (room: string) => ({ emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }) }),
    in: () => ({ socketsLeave: () => undefined }),
  }
})

afterAll(async () => {
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeEach(() => {
  sent.mockClear()
  emitted.length = 0
  mockCheck.mockReset()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

beforeAll(async () => {
  const host = await makeUser(testId("bat-host"), "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
})

const newPost = async (authorId: string, body = "two seats from Indiranagar") =>
  (await db.board_posts.create({ data: { event_id: eventId, author_id: authorId, kind: "offer", body, spaces_left: 2 }, select: { id: true } })).id

/** The dedicated event; the bell's own `notification:new` rides the same room and is checked separately. */
const removedEvents = () => emitted.filter((e) => e.event === "board:postRemoved")

const pushes = () => sent.mock.calls.flatMap((c) => c[0].map((m) => `${m.data?.type}:${m.to}`))

describe("the automatic check takes a post down", () => {
  it("tells the author, with ids and no words", async () => {
    const author = await person("bat-a1")
    const bystander = await person("bat-b1")
    const postId = await newPost(author.id, "secret words nobody else should see on a lock screen")
    mockCheck.mockResolvedValue({ checked: true, result: { action: "hide" } })

    await hideBoardPostIfFlagged(postId, "x")

    expect(removedEvents()).toEqual([{ room: `user:${author.id}`, event: "board:postRemoved", payload: { eventId, postId } }])
    expect(pushes()).toEqual([`board_post_removed:ExponentPushToken[itest-${author.id}]`])
    const bell = await db.notifications.findMany({ where: { user_id: { in: [author.id, bystander.id] } } })
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ user_id: author.id, kind: "board_post_removed" })
    expect(JSON.stringify(bell[0])).not.toContain("secret words")
    expect(bell[0].data).toEqual({ type: "board_post_removed", eventId, postId })
    // The bell's own signal reaches the same person.
    expect(emitted).toContainEqual({ room: [`user:${author.id}`], event: "notification:new", payload: { kind: "board_post_removed" } })
  })

  it("says nothing when the check clears the post", async () => {
    const author = await person("bat-a2")
    const postId = await newPost(author.id)
    mockCheck.mockResolvedValue({ checked: true, result: { action: "allow" } })
    await hideBoardPostIfFlagged(postId, "x")
    expect(removedEvents()).toEqual([])
    expect(sent).not.toHaveBeenCalled()
  })

  it("says nothing about a post its author had already withdrawn", async () => {
    const author = await person("bat-a3")
    const postId = await newPost(author.id)
    await db.board_posts.update({ where: { id: postId }, data: { deleted_at: new Date() } })
    mockCheck.mockResolvedValue({ checked: true, result: { action: "hide" } })
    await hideBoardPostIfFlagged(postId, "x")
    expect(removedEvents()).toEqual([])
    expect(sent).not.toHaveBeenCalled()
  })
})

describe("a moderator removes a post", () => {
  async function reported(authorId: string, postId: string) {
    const viewer = await person("bat-viewer")
    const report = await db.message_reports.create({
      data: { reporter_id: viewer.id, message_id: postId, message_type: "board_post", reason: "harassment" },
    })
    const adminId = await makeUser(testId("bat-admin"), "app_admin")
    users.push(adminId)
    session = { user: { id: adminId, role: "app_admin" } }
    void authorId
    return report.id
  }

  it("tells the author once; a second removal of the same post tells nobody again", async () => {
    const author = await person("bat-a4")
    const postId = await newPost(author.id)
    const first = await reported(author.id, postId)
    const second = await reported(author.id, postId)

    await resolveReport("message", first, "remove_message")
    expect(removedEvents()).toEqual([{ room: `user:${author.id}`, event: "board:postRemoved", payload: { eventId, postId } }])
    expect(pushes()).toEqual([`board_post_removed:ExponentPushToken[itest-${author.id}]`])

    emitted.length = 0
    sent.mockClear()
    await resolveReport("message", second, "remove_message")
    expect(removedEvents()).toEqual([])
    expect(sent).not.toHaveBeenCalled()
  })

  it("does not tell an author who had withdrawn the post first", async () => {
    const author = await person("bat-a5")
    const postId = await newPost(author.id)
    const report = await reported(author.id, postId)
    await db.board_posts.update({ where: { id: postId }, data: { deleted_at: new Date() } })
    await resolveReport("message", report, "remove_message")
    expect(removedEvents()).toEqual([])
    expect(sent).not.toHaveBeenCalled()
  })
})

describe("the author's own board read lists what was taken down, theirs only", () => {
  const read = (token: string) =>
    boardRoute.GET(new NextRequest(`http://localhost/api/mobile/events/${eventId}/board`, { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ eventId }),
    })

  it("shows the author the removed and hidden posts, not a withdrawal, and nobody else", async () => {
    const author = await person("bat-a6")
    const other = await person("bat-o6")
    for (const u of [author, other]) await db.event_rsvps.create({ data: { event_id: eventId, user_id: u.id, status: "going" } })
    const removed = await newPost(author.id, "removed one")
    const hidden = await newPost(author.id, "hidden one")
    const withdrawn = await newPost(author.id, "withdrawn one")
    const live = await newPost(author.id, "live one")
    const now = new Date()
    await db.board_posts.update({ where: { id: removed }, data: { deleted_at: now, moderation_status: "removed" } })
    await db.board_posts.update({ where: { id: hidden }, data: { deleted_at: now, moderation_status: "hidden" } })
    await db.board_posts.update({ where: { id: withdrawn }, data: { deleted_at: now } })
    // The board reads only before doors.
    const start = new Date(Date.now() + 24 * 3600_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3600_000) } })
    await db.profiles.upsert({ where: { id: author.id }, create: { id: author.id, name: "A", onboarded: true }, update: {} })
    await db.profiles.upsert({ where: { id: other.id }, create: { id: other.id, name: "O", onboarded: true }, update: {} })

    const mine = (await (await read(author.token)).json()) as { data: { takenDown: { id: string; takenDownAt: string }[]; posts: { id: string }[] } }
    expect(mine.data.takenDown.map((p) => p.id).sort()).toEqual([removed, hidden].sort())
    const listed = mine.data.posts.map((p) => p.id)
    expect(listed).toContain(live)
    expect(listed).not.toContain(removed)
    expect(listed).not.toContain(hidden)
    expect(listed).not.toContain(withdrawn)
    expect(mine.data.takenDown[0]).toHaveProperty("takenDownAt")

    const theirs = (await (await read(other.token)).json()) as { data: { takenDown: unknown[] } }
    expect(theirs.data.takenDown).toEqual([])
  })
})

it("a withdrawal by the author is not told to the author", async () => {
  const author = await person("bat-a7")
  const postId = await newPost(author.id)
  const res = await postRoute.DELETE(
    new NextRequest(`http://localhost/api/mobile/events/${eventId}/board/${postId}`, { method: "DELETE", headers: { authorization: `Bearer ${author.token}` } }),
    { params: Promise.resolve({ eventId, postId }) }
  )
  expect(res.status).toBe(200)
  expect(removedEvents()).toEqual([])
  expect(sent).not.toHaveBeenCalled()
})
