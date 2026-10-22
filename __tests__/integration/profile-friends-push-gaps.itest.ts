/**
 * The profile, friends and notification-settings gaps (Flows 6 and 9): the
 * owner's photo states, the badges, the per-kind push switches, the channel a
 * push is filed under, and the reasons friends refusals carry. Real handlers,
 * real rows.
 *
 * What was there is asserted beside what is new: installed apps read the old
 * shape.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
type Msg = { to: string; channelId?: string; threadId?: string; data: { type: string } }
const sentMessages: Msg[] = []
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Msg[]) {
      sentMessages.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  }
  return { Expo }
})

import { NextRequest } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { notifyEventChanged, sendPushNotification } from "@/lib/push-notifications"
import { notePulledProfilePhoto, recordPhotoPulled } from "@/lib/photo-checks"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"
import { req } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const prefsRoute = require("@/app/api/mobile/me/notification-preferences/route") as typeof import("@/app/api/mobile/me/notification-preferences/route")
const requestsRoute = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
const requestRoute = require("@/app/api/mobile/friends/requests/[requestId]/route") as typeof import("@/app/api/mobile/friends/requests/[requestId]/route")
const inviteRoute = require("@/app/api/mobile/friends/invite/[token]/route") as typeof import("@/app/api/mobile/friends/invite/[token]/route")
const previewRoute = require("@/app/api/mobile/friends/invite/[token]/preview/route") as typeof import("@/app/api/mobile/friends/invite/[token]/preview/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, opts: { onboarded?: boolean; showBadges?: boolean; photos?: string[] } = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({
    where: { id },
    create: { id, name: "Test", onboarded: opts.onboarded ?? true, ...(opts.photos && { photos: opts.photos }), ...(opts.showBadges !== undefined && { show_badges: opts.showBadges }) },
    update: {},
  })
  return id
}

async function withToken(userId: string, channelSet: number | null = 2) {
  await db.push_tokens.create({
    data: { user_id: userId, token: `ExponentPushToken[${userId}]`, platform: "android", ...(channelSet !== null && { channel_set: channelSet }) },
  })
}

const getProfile = async (viewer: string, subject: string) => {
  const res = await profileRoute.GET(req(`/api/mobile/profiles/${subject}`, tokenOf(viewer)), { params: Promise.resolve({ userId: subject }) })
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  sentMessages.length = 0
})

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.photo_checks.deleteMany({ where: { user_id: { in: users } } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { blocker_id: { in: users } } })
  await db.friend_invites.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

describe("GET /profiles/:id — photo_states", () => {
  it("the owner gets their photos with a verdict on each; a pulled photo is a slot that says so", async () => {
    const live = "https://cdn.test/profile/p1/live.jpg"
    const gone = "https://cdn.test/profile/p1/gone.jpg"
    const me = await person("pf-owner", { photos: [live] })
    // A blurred copy pulled with its photo is not a tile.
    await recordPhotoPulled("https://cdn.test/profile/p1/blur-sealed", me)
    await recordPhotoPulled(gone, me)
    await notePulledProfilePhoto(gone, me, true)

    const { json } = await getProfile(me, me)
    const profile = json.data.profile

    // What was there.
    expect(profile.photos).toEqual([live])
    expect(profile.push_enabled).toBe(true)
    // What is new.
    // A pulled photo's URL is never sent back: a CDN that still held it would keep showing it.
    expect(JSON.stringify(profile.photo_states)).not.toContain(gone)
    expect(profile.photo_states).toEqual([
      { url: live, pulled: false, pulled_at: null, was_main: false },
      { url: null, pulled: true, pulled_at: expect.any(String), was_main: true },
    ])
  })

  it("a pull older than the notice window is no longer listed, and nobody else ever sees one", async () => {
    const stale = "https://cdn.test/profile/p2/stale.jpg"
    const me = await person("pf-stale")
    const other = await person("pf-other")
    await recordPhotoPulled(stale, me)
    await notePulledProfilePhoto(stale, me, false)
    await db.photo_checks.update({ where: { url: stale }, data: { pulled_at: new Date(Date.now() - 8 * 86_400_000) } })

    expect((await getProfile(me, me)).json.data.profile.photo_states).toEqual([])
    // A pull inside the window, read by somebody else: no states at all.
    const fresh = "https://cdn.test/profile/p2/fresh.jpg"
    await recordPhotoPulled(fresh, me)
    await notePulledProfilePhoto(fresh, me, false)
    expect((await getProfile(other, me)).json.data.profile).not.toHaveProperty("photo_states")
  })
})

describe("GET /profiles/:id — badges", () => {
  it("none earned is an empty list for the owner; the key is absent when they turned badges off", async () => {
    const shows = await person("pf-b-on")
    expect((await getProfile(shows, shows)).json.data.profile.badges).toEqual([])

    const hides = await person("pf-b-off", { showBadges: false })
    expect((await getProfile(hides, hides)).json.data.profile).not.toHaveProperty("badges")
  })

  it("five nights out this month is the tier badge, never a count, for the owner and for somebody who can see who they are", async () => {
    const me = await person("pf-b-nights")
    const organiser = await person("pf-b-host")
    for (let i = 0; i < 5; i++) {
      const eventId = await makeEvent(organiser)
      events.push(eventId)
      await putInRoom({ eventId, occurrenceId: await occurrenceOf(eventId), userId: me })
    }

    const own = await getProfile(me, me)
    expect(own.json.data.profile.badges).toEqual([{ kind: "nights_out", label: "5+ nights this month" }])
    expect(JSON.stringify(own.json.data.profile.badges)).not.toMatch(/\b5 nights\b/)

    // A stranger is not told who this is, and is not given what is earned by being them.
    const stranger = await person("pf-b-stranger")
    expect((await getProfile(stranger, me)).json.data.profile).not.toHaveProperty("badges")
  })
})

describe("the per-kind push switches", () => {
  const prefs = (token: string, method: "GET" | "PUT" = "GET", body?: unknown) =>
    prefsRoute[method](req("/api/mobile/me/notification-preferences", token, method, body))

  it("GET answers all three on by default; PUT takes any subset and answers all three", async () => {
    const me = await person("pf-sw")
    const token = tokenOf(me)
    const first = await prefs(token)
    expect(first.status).toBe(200)
    expect((await first.json()).data).toEqual({ matches: true, crew: true, night: true })

    const put = await prefs(token, "PUT", { crew: false })
    expect(put.status).toBe(200)
    expect((await put.json()).data).toEqual({ matches: true, crew: false, night: true })
    expect((await (await prefs(token)).json()).data).toEqual({ matches: true, crew: false, night: true })

    // A second subset leaves the first alone.
    expect((await (await prefs(token, "PUT", { night: false })).json()).data).toEqual({ matches: true, crew: false, night: false })
    // Nothing else on the profile moved.
    expect((await getProfile(me, me)).json.data.profile.push_enabled).toBe(true)
  })

  it("refuses an empty body, a non-boolean and a key it does not know, and changes nothing", async () => {
    const me = await person("pf-sw-bad")
    const token = tokenOf(me)
    for (const bad of [{}, { crew: "no" }, { crew: null }, { crews: false }, { crew: false, extra: 1 }]) {
      const res = await prefs(token, "PUT", bad)
      expect(res.status).toBe(400)
      expect((await res.json()).errorCode).toBe("VALIDATION_FAILED")
    }
    expect((await (await prefs(token)).json()).data).toEqual({ matches: true, crew: true, night: true })
    expect((await prefsRoute.GET(new NextRequest("http://localhost/api/mobile/me/notification-preferences"))).status).toBe(401)
  })

  it("a switch stops its kind's push and nothing else; the bell still fills", async () => {
    const me = await person("pf-gate")
    await withToken(me)
    await db.profiles.update({ where: { id: me }, data: { push_crew: false, push_night: false } })

    const send = (type: string, extra: Record<string, string> = {}) =>
      sendPushNotification({ userId: me, title: "t", body: "b", data: { type: type as never, ...extra } })

    expect(await send("crew_here")).toBe(false)
    expect(await send("blend")).toBe(false)
    expect(await send("crew_invite")).toBe(false)
    expect(await send("rating_request", { eventId: "e1" })).toBe(false)
    expect(sentMessages).toHaveLength(0)

    // Matches and everything with no switch still go.
    expect(await send("friend_request")).toBe(true)
    expect(await send("match", { conversationId: "c1" })).toBe(true)
    expect(await send("event_update", { eventId: "e1" })).toBe(true)
    expect(sentMessages.map((m) => m.data.type)).toEqual(["friend_request", "match", "event_update"])

    const rows = await db.notifications.findMany({ where: { user_id: me }, select: { kind: true } })
    expect(rows.map((r) => r.kind).sort()).toEqual(
      ["blend", "crew_here", "crew_invite", "event_update", "friend_request", "match", "rating_request"].sort()
    )
  })

  it("matches off stops every kind it covers, the board's included, and nothing outside it", async () => {
    const me = await person("pf-gate-matches")
    await withToken(me)
    await db.profiles.update({ where: { id: me }, data: { push_matches: false } })
    const send = (type: string) => sendPushNotification({ userId: me, title: "t", body: "b", data: { type: type as never } })

    for (const type of ["friend_request", "friend_accepted", "match", "reveal", "reveal_request", "board_request", "board_request_accepted"]) {
      expect(await send(type)).toBe(false)
    }
    // Not in matches: a message request, a crew kind, an event, a report's outcome.
    for (const type of ["message_request", "crew_here", "event_update", "report_actioned"]) {
      expect(await send(type)).toBe(true)
    }
  })

  it("a person with no profile row keeps hearing: the switch excludes the explicit off, it does not require an on", async () => {
    const id = await makeUser(testId("pf-noprofile"))
    users.push(id)
    await withToken(id)
    expect(await sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "crew_here" } })).toBe(true)
  })

  it("the bulk path honours them too", async () => {
    const quiet = await person("pf-bulk-off")
    const loud = await person("pf-bulk-on")
    await withToken(quiet)
    await withToken(loud)
    await db.profiles.update({ where: { id: quiet }, data: { push_night: false } })
    const { sendBulkPushNotifications } = await import("@/lib/push-notifications")
    await sendBulkPushNotifications({ userIds: [quiet, loud], title: "t", body: "b", data: { type: "rating_request", eventId: "e1" } })
    expect(sentMessages.map((m) => m.to)).toEqual([`ExponentPushToken[${loud}]`])
  })
})

describe("the channel a push is filed under", () => {
  it("a build that created the new channels gets each kind on one of them; an older build keeps exactly what it had", async () => {
    const fresh = await person("pf-ch-new")
    const old = await person("pf-ch-old")
    await withToken(fresh, 2)
    await withToken(old, null)

    const kinds: Array<[string, Record<string, string>]> = [
      ["friend_request", {}],
      ["crew_here", { chatGroupId: "g1" }],
      ["rating_request", { eventId: "e1" }],
      ["venue_offer", { offerId: "o1" }],
      ["report_actioned", {}],
      ["private_message", { conversationId: "c1" }],
      ["event_update", { eventId: "e1" }],
    ]
    for (const [type, extra] of kinds) {
      await db.profiles.update({ where: { id: fresh }, data: { offer_push_consent_at: new Date() } })
      await db.profiles.update({ where: { id: old }, data: { offer_push_consent_at: new Date() } })
      await sendPushNotification({ userId: fresh, title: "t", body: "b", data: { type: type as never, ...extra } })
      await sendPushNotification({ userId: old, title: "t", body: "b", data: { type: type as never, ...extra } })
    }

    const channelOf = (user: string, type: string) => sentMessages.find((m) => m.to === `ExponentPushToken[${user}]` && m.data.type === type)?.channelId
    expect(kinds.map(([type]) => channelOf(fresh, type))).toEqual(["matches", "crew", "after-the-night", "offers", "default", "messages", "events"])
    // Before Flow 9: every kind the default case caught was `messages`, and rating rode `events`.
    expect(kinds.map(([type]) => channelOf(old, type))).toEqual(["messages", "messages", "events", "offers", "messages", "messages", "events"])
  })

  it("event_changed reaches an older build as event_update, so a tap still opens the event", async () => {
    const old = await person("pf-ec-old")
    const fresh = await person("pf-ec-new")
    await withToken(old, null)
    await withToken(fresh, 2)
    await notifyEventChanged([old, fresh], "Night", "Event updated: start time", "e1", "time")
    const typeOf = (u: string) => sentMessages.find((m) => m.to === `ExponentPushToken[${u}]`)?.data.type
    expect(typeOf(old)).toBe("event_update")
    expect(typeOf(fresh)).toBe("event_changed")
  })
})

describe("friends: reasons that never say why somebody is out of reach", () => {
  const post = (userId: string, body: object) => requestsRoute.POST(req("/api/mobile/friends/requests", tokenOf(userId), "POST", body))
  const body = async (res: Response) => res.json()

  it("an unfinished profile: FORBIDDEN with its sentence, and PROFILE_INCOMPLETE beside it", async () => {
    const unfinished = await person("fr-unfin", { onboarded: false })
    const res = await post(unfinished, { userId: "nobody" })
    expect(res.status).toBe(403)
    expect(await body(res)).toMatchObject({ success: false, errorCode: "FORBIDDEN", reasonCode: "PROFILE_INCOMPLETE" })
  })

  it("asking yourself is the 400 it was, with CANNOT_ADD_SELF", async () => {
    const me = await person("fr-self")
    const res = await post(me, { userId: me })
    expect(res.status).toBe(400)
    const json = await body(res)
    expect(json).toMatchObject({ success: false, error: "You can't add yourself", reasonCode: "CANNOT_ADD_SELF" })
    expect(json).not.toHaveProperty("errorCode")
  })

  it("a person who does not exist and one who blocked you answer identically", async () => {
    const me = await person("fr-asker")
    const blocker = await person("fr-blocker")
    await db.blocked_users.create({ data: { blocker_id: blocker, blocked_id: me } })

    const unknown = await post(me, { userId: "cuid-that-is-nobody" })
    const blocked = await post(me, { userId: blocker })
    expect(unknown.status).toBe(404)
    expect(blocked.status).toBe(404)
    const expected = { success: false, error: "Not found", errorCode: "NOT_FOUND", reasonCode: "PERSON_UNAVAILABLE" }
    expect(await body(unknown)).toEqual(expected)
    expect(await body(blocked)).toEqual(expected)
  })

  it("an invite whose owner blocked you answers exactly as one that never existed", async () => {
    const me = await person("fr-inv-asker")
    const owner = await person("fr-inv-owner")
    const token = "B".repeat(22)
    await db.friend_invites.create({ data: { user_id: owner, token } })
    await db.blocked_users.create({ data: { blocker_id: owner, blocked_id: me } })

    const blocked = await post(me, { token })
    const unknown = await post(me, { token: "C".repeat(22) })
    expect(blocked.status).toBe(404)
    expect(await body(blocked)).toEqual(await body(unknown))
    expect(await body(await post(me, { token }))).toMatchObject({ errorCode: "NOT_FOUND", reasonCode: "INVITE_UNAVAILABLE" })
  })

  it("an invite that does not work answers one way: asked for, and opened", async () => {
    const me = await person("fr-invitee")
    const token = "A".repeat(22)

    const asked = await post(me, { token })
    expect(asked.status).toBe(404)
    expect(await body(asked)).toEqual({ success: false, error: "Not found", errorCode: "NOT_FOUND", reasonCode: "INVITE_UNAVAILABLE" })

    const landing = await inviteRoute.GET(req(`/api/mobile/friends/invite/${token}`, tokenOf(me)), { params: Promise.resolve({ token }) })
    expect(landing.status).toBe(404)
    expect(await body(landing)).toEqual({
      success: false,
      error: "This invite link doesn't work any more",
      errorCode: "NOT_FOUND",
      reasonCode: "INVITE_UNAVAILABLE",
    })

    const malformed = await inviteRoute.GET(req("/api/mobile/friends/invite/short", tokenOf(me)), { params: Promise.resolve({ token: "short" }) })
    expect((await body(malformed)).reasonCode).toBe("INVITE_UNAVAILABLE")

    const preview = await previewRoute.GET(new NextRequest(`http://localhost/api/mobile/friends/invite/${token}/preview`), { params: Promise.resolve({ token }) })
    expect(preview.status).toBe(404)
    expect((await body(preview)).reasonCode).toBe("INVITE_UNAVAILABLE")
  })

  it("a request that is gone, never was or is somebody else's: REQUEST_UNAVAILABLE, and an unfinished profile cannot accept", async () => {
    const me = await person("fr-resp")
    const gone = "123e4567-e89b-42d3-a456-426614174000"
    for (const id of [gone, "not-a-uuid"]) {
      const res = await requestRoute.POST(req(`/api/mobile/friends/requests/${id}`, tokenOf(me), "POST", { action: "accept" }), { params: Promise.resolve({ requestId: id }) })
      expect(res.status).toBe(404)
      expect(await body(res)).toEqual({ success: false, error: "Not found", errorCode: "NOT_FOUND", reasonCode: "REQUEST_UNAVAILABLE" })
    }

    const unfinished = await person("fr-resp-unfin", { onboarded: false })
    const res = await requestRoute.POST(req(`/api/mobile/friends/requests/${gone}`, tokenOf(unfinished), "POST", { action: "accept" }), { params: Promise.resolve({ requestId: gone }) })
    expect(res.status).toBe(403)
    expect(await body(res)).toMatchObject({ errorCode: "FORBIDDEN", reasonCode: "PROFILE_INCOMPLETE" })
  })
})
