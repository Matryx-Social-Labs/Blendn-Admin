import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// No push leaves the test: the fixtures have no tokens, and this makes sure.
const mockExpoSends = jest.fn()
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: unknown[]) {
      mockExpoSends(chunk)
      return chunk.map(() => ({ status: "ok" }))
    }
  },
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { canJoinChat } from "@/lib/socket-auth"
import { sendRatingRequests } from "@/lib/services/event-notifications.service"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * The end of a night, driven through the real handlers against a real database:
 * leaving a room and coming back, muting it, reporting it, reading back your
 * own rating, the signed-out invite preview, and the "rate who you met" push.
 *
 * Real Postgres matters here for three reasons the unit suite cannot see: the
 * new `notification_kind` value has to be accepted by the enum, the claim on
 * `rating_requested_at` has to be a real compare-and-set, and `left_at` has to
 * round-trip through every read that now depends on it.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const groups = require("@/app/api/mobile/chat/groups/route") as typeof import("@/app/api/mobile/chat/groups/route")
const messages = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const leave = require("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route")
const mute = require("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/mute/route")
const report = require("@/app/api/mobile/chat/groups/[chatGroupId]/report/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/report/route")
const rating = require("@/app/api/mobile/events/[eventId]/rating/route") as typeof import("@/app/api/mobile/events/[eventId]/rating/route")
const preview = require("@/app/api/mobile/friends/invite/[token]/preview/route") as typeof import("@/app/api/mobile/friends/invite/[token]/preview/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  if (events.length) await db.event_reports.deleteMany({ where: { event_id: { in: events } } })
  if (users.length) await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string): Promise<{ id: string; token: string }> {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function call(
  handler: Handler,
  path: string,
  as: { token: string } | null,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}
) {
  const res = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(as && { authorization: `Bearer ${as.token}` }),
      },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, json: await res.json() }
}

describe("a room you leave, mute and report", () => {
  let host: string
  let me: { id: string; token: string }
  let other: { id: string; token: string }
  let outsider: { id: string; token: string }
  let eventId: string
  let chatGroupId: string

  beforeAll(async () => {
    host = await makeUser(testId("rj-host"), "organizer")
    users.push(host)
    me = await person("rj-me")
    other = await person("rj-other")
    outsider = await person("rj-outsider")
    eventId = await makeEvent(host)
    events.push(eventId)
    const occurrenceId = await occurrenceOf(eventId)
    for (const u of [me, other]) await putInRoom({ eventId, occurrenceId, userId: u.id })

    // Opening the room joins you: the ordinary way in.
    const opened = await call(eventChat.GET as Handler, `/api/mobile/events/${eventId}/chat`, me, { params: { eventId } })
    expect(opened.status).toBe(200)
    chatGroupId = opened.json.data.chatGroupId
    expect(opened.json.data.mute).toEqual({ muted: false, until: null })
    await call(eventChat.GET as Handler, `/api/mobile/events/${eventId}/chat`, other, { params: { eventId } })
  })

  const room = (as: { token: string }, handler: Handler, method = "POST", body?: unknown) =>
    call(handler, `/api/mobile/chat/groups/${chatGroupId}/x`, as, { method, body, params: { chatGroupId } })

  it("mutes and unmutes, and the chat screen and the list both say so", async () => {
    const until = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    const muted = await room(me, mute.POST as Handler, "POST", { until })
    expect(muted.status).toBe(200)
    expect(muted.json.data.mute).toEqual({ muted: true, until })

    const screen = await call(eventChat.GET as Handler, `/api/mobile/events/${eventId}/chat`, me, { params: { eventId } })
    expect(screen.json.data.mute).toEqual({ muted: true, until })

    const list = await call(groups.GET as unknown as Handler, "/api/mobile/chat/groups", me)
    const item = list.json.data.groups.find((g: { id: string }) => g.id === chatGroupId)
    expect(item.mute).toEqual({ muted: true, until })

    // Read back: stored per member, in the column that was made for it.
    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
      select: { notification_preferences: true, status: true },
    })
    expect(row.notification_preferences).toEqual({ muted: true, muted_until: until })
    expect(row.status).toBe("active") // not the organiser's mute

    const unmuted = await room(me, mute.DELETE as Handler, "DELETE")
    expect(unmuted.json.data.mute).toEqual({ muted: false, until: null })
  })

  it("leaves: out of the room everywhere, and opening it does not put you back", async () => {
    const left = await room(me, leave.POST as Handler)
    expect(left.status).toBe(200)
    expect(left.json.data).toEqual({ chatGroupId, left: true })
    // Idempotent.
    expect((await room(me, leave.POST as Handler)).status).toBe(200)

    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
      select: { status: true, left_at: true, anonymous_name: true },
    })
    expect(row.status).toBe("left")
    expect(row.left_at).toBeInstanceOf(Date)
    expect(row.anonymous_name).toBeTruthy() // kept: the transcript resolves through it

    // The Room tab reloads the chat for the event you are checked in to.
    const reopened = await call(eventChat.GET as Handler, `/api/mobile/events/${eventId}/chat`, me, { params: { eventId } })
    expect(reopened.status).toBe(403)
    expect(reopened.json).toMatchObject({ errorCode: "LEFT_ROOM", chatGroupId })
    const still = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
      select: { status: true },
    })
    expect(still.status).toBe("left")

    const history = await call(messages.GET as Handler, `/api/mobile/chat/groups/${chatGroupId}/messages`, me, {
      params: { chatGroupId },
    })
    expect(history.status).toBe(403)

    const post = await call(eventChat.POST as Handler, `/api/mobile/events/${eventId}/chat`, me, {
      method: "POST",
      body: { content: "still here?", type: "text" },
      params: { eventId },
    })
    expect(post.status).toBe(403)
    expect(post.json.errorCode).toBe("LEFT_ROOM")

    expect(await canJoinChat(me.id, chatGroupId)).toBe(false)
    expect(await canJoinChat(other.id, chatGroupId)).toBe(true)

    const list = await call(groups.GET as unknown as Handler, "/api/mobile/chat/groups", me)
    expect(list.json.data.groups.map((g: { id: string }) => g.id)).not.toContain(chatGroupId)
  })

  it("rejoins with DELETE, and the room opens again", async () => {
    const back = await room(me, leave.DELETE as Handler, "DELETE")
    expect(back.status).toBe(200)
    expect(back.json.data).toEqual({ chatGroupId, left: false })

    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
      select: { status: true, left_at: true },
    })
    expect(row).toEqual({ status: "active", left_at: null })

    const reopened = await call(eventChat.GET as Handler, `/api/mobile/events/${eventId}/chat`, me, { params: { eventId } })
    expect(reopened.status).toBe(200)
    expect(await canJoinChat(me.id, chatGroupId)).toBe(true)
  })

  it("files a room report the admin queue can find, and refuses anybody who was never in it", async () => {
    const filed = await room(other, report.POST as Handler, "POST", { reason: "harassment", description: "a pile-on" })
    expect(filed.status).toBe(201)

    const rows = await db.event_reports.findMany({
      where: { event_id: eventId, user_id: other.id },
      select: { chat_group_id: true, reason: true, description: true, status: true },
    })
    expect(rows).toEqual([{ chat_group_id: chatGroupId, reason: "harassment", description: "a pile-on", status: "pending" }])

    const stranger = await room(outsider, report.POST as Handler, "POST", { reason: "spam" })
    expect(stranger.status).toBe(404)
    expect(stranger.json.errorCode).toBe("NOT_FOUND")
  })
})

describe("your own event rating", () => {
  it("is null until you rate, then reads back what you gave", async () => {
    const host = await makeUser(testId("rr-host"), "organizer")
    users.push(host)
    const me = await person("rr-me")
    const eventId = await makeEvent(host)
    events.push(eventId)
    const path = `/api/mobile/events/${eventId}/rating`

    const before = await call(rating.GET as Handler, path, me, { params: { eventId } })
    expect(before.status).toBe(200)
    expect(before.json.data).toEqual({ rating: null, review: null, ratedAt: null })

    await db.event_ratings.create({ data: { event_id: eventId, user_id: me.id, rating: 5, review: "Loved it" } })
    const after = await call(rating.GET as Handler, path, me, { params: { eventId } })
    expect(after.json.data).toMatchObject({ rating: 5, review: "Loved it" })
    expect(typeof after.json.data.ratedAt).toBe("string")
  })
})

describe("the signed-out invite preview", () => {
  it("answers a first name with no token at all, and the same 404 once the link is reset", async () => {
    const owner = await person("ip-owner")
    await db.profiles.update({ where: { id: owner.id }, data: { name: "Meera Iyer", photos: [] } })
    const token = "Abcdefghijklmnopqrst_" + "1"
    await db.friend_invites.create({ data: { user_id: owner.id, token } })

    const open = await call(preview.GET as Handler, `/api/mobile/friends/invite/${token}/preview`, null, { params: { token } })
    expect(open.status).toBe(200)
    expect(open.json.data).toEqual({ name: "Meera", photoUrl: null })

    await db.friend_invites.update({ where: { user_id: owner.id }, data: { token: "Zbcdefghijklmnopqrst_2" } })
    const reset = await call(preview.GET as Handler, `/api/mobile/friends/invite/${token}/preview`, null, { params: { token } })
    expect(reset.status).toBe(404)
    expect(reset.json.errorCode).toBe("NOT_FOUND")
  })

  it("applies a block for a caller who is signed in", async () => {
    const owner = await person("ip-owner-b")
    const blocked = await person("ip-blocked")
    const token = "Bbcdefghijklmnopqrst_3"
    await db.friend_invites.create({ data: { user_id: owner.id, token } })
    await db.blocked_users.create({ data: { blocker_id: owner.id, blocked_id: blocked.id } })

    const res = await call(preview.GET as Handler, `/api/mobile/friends/invite/${token}/preview`, blocked, { params: { token } })
    expect(res.status).toBe(404)
    await db.blocked_users.deleteMany({ where: { blocker_id: owner.id } })
  })
})

describe("the rate-who-you-met push", () => {
  it("asks everyone who was there exactly once, and never about an old night", async () => {
    const host = await makeUser(testId("rq-host"), "organizer")
    users.push(host)
    const a = await person("rq-a")
    const b = await person("rq-b")
    const late = await person("rq-late")

    const now = Date.now()
    const ended = await makeEvent(host)
    const ancient = await makeEvent(host)
    events.push(ended, ancient)
    await db.events.update({
      where: { id: ended },
      data: { start_time: new Date(now - 4 * 3600_000), end_time: new Date(now - 10 * 60_000) },
    })
    await db.events.update({
      where: { id: ancient },
      data: { start_time: new Date(now - 50 * 3600_000), end_time: new Date(now - 48 * 3600_000) },
    })
    const occ = await occurrenceOf(ended)
    await putInRoom({ eventId: ended, occurrenceId: occ, userId: a.id })
    await putInRoom({ eventId: ended, occurrenceId: occ, userId: b.id })
    await putInRoom({ eventId: ancient, occurrenceId: await occurrenceOf(ancient), userId: late.id })
    // Checked out by the end, as most people are: attendance, not presence.
    await db.event_check_ins.updateMany({ where: { event_id: ended, user_id: b.id }, data: { status: "checked_out" } })

    await sendRatingRequests()
    await sendRatingRequests() // the next pass, five minutes later

    const rows = await db.notifications.findMany({
      where: { user_id: { in: [a.id, b.id, late.id] }, kind: "rating_request" },
      select: { user_id: true, data: true },
    })
    expect(rows.map((r) => r.user_id).sort()).toEqual([a.id, b.id].sort())
    for (const r of rows) expect(r.data).toMatchObject({ type: "rating_request", eventId: ended })

    const claimed = await db.events.findUniqueOrThrow({ where: { id: ended }, select: { rating_requested_at: true } })
    expect(claimed.rating_requested_at).toBeInstanceOf(Date)
    const old = await db.events.findUniqueOrThrow({ where: { id: ancient }, select: { rating_requested_at: true } })
    expect(old.rating_requested_at).toBeNull()
  })
})
