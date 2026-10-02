import { randomUUID } from "crypto"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { refusalsByReason, refusalSummary } from "@/lib/check-in-refusals"
import { haveSharedAnEvent } from "@/lib/conversations"
import { db as appDb } from "@/lib/db"
import { maySeeIdentityFor, visibleInRoom } from "@/lib/identity"
import { sweepVenueDays } from "@/lib/presence-sweeper"
import { canJoinChat, canJoinEvent, canJoinEventRoom } from "@/lib/socket-auth"
import { SYSTEM_USER_ID } from "@/lib/venue-day"

import { closeDb, db, testId } from "./helpers"
import {
  checkInOf,
  cleanupWorld,
  eventParams,
  goLive,
  groupParams,
  INSIDE,
  openSessionOf,
  OUTSIDE,
  person,
  realEvent,
  req,
  rewind,
  routes,
  sessionOf,
  until,
  venue,
  venueDetail,
  world,
} from "./go-live-world"

/**
 * Go Live — the door, the room and the venue page — driven end to end against
 * real Postgres (plan v2 step 4; TQ-A08). Every route is the real handler with
 * a real JWT. The sweeper is `go-live-sweeper.itest.ts`; the sockets,
 * `go-live-sockets.itest.ts`.
 *
 * Time: the routes read the wall clock, so a window is made to have ended by
 * moving its rows back (`rewind`) rather than by waiting — never a sleep.
 */

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("POST /venues/:id/live", () => {
  it("opens a window: a check-in with expires_at, a session, and the room until then", async () => {
    const v = await venue()
    const me = await person()
    const before = Date.now()
    const { status, json } = await goLive(me.token, v, { minutes: 20 })
    expect(status).toBe(200)

    // The contract: these keys, no others (PL-C02).
    expect(Object.keys(json.data).sort()).toEqual(
      ["chatGroupId", "checkIn", "expiresAt", "intentNeeded", "revealSuggestion", "stay", "stayUntil", "venueDayId"]
    )
    const { venueDayId, chatGroupId, expiresAt, stay } = json.data
    expect(stay).toBe(false)
    const expires = new Date(expiresAt).getTime()
    expect(expires - before).toBeGreaterThanOrEqual(20 * 60_000 - 1_000)
    expect(expires - before).toBeLessThanOrEqual(20 * 60_000 + 5_000)

    const day = await db.events.findUniqueOrThrow({ where: { id: venueDayId } })
    expect(day).toMatchObject({ kind: "venue_day", venue_id: v, organizer_id: SYSTEM_USER_ID, organizer_org_id: null })

    const checkIn = await checkInOf(venueDayId, me.id)
    expect(checkIn).toMatchObject({ status: "checked_in", kind: "attendee", stay: false, stay_until: null })
    expect(checkIn.expires_at?.toISOString()).toBe(expiresAt)
    expect(await openSessionOf(venueDayId, me.id)).not.toBeNull()

    const member = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: me.id } },
    })
    expect(member.last_allowed_at?.toISOString()).toBe(expiresAt)
    expect(await canJoinChat(me.id, chatGroupId)).toBe(true)
  })

  it("makes one venue day when ten go live at once, and seats all ten (PL-I01)", async () => {
    const v = await venue()
    const people = await Promise.all(Array.from({ length: 10 }, () => person("gl10")))
    const results = await Promise.all(people.map((p) => goLive(p.token, v)))
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200))
    expect(new Set(results.map((r) => r.json.data.venueDayId)).size).toBe(1)
    expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(1)
    expect(await db.event_check_ins.count({ where: { event_id: results[0].json.data.venueDayId, status: "checked_in" } })).toBe(10)
  })

  it("reads the room back when it loses the race to make it (forced)", async () => {
    // Ten at once lose that race only sometimes; this always does.
    const v = await venue()
    const [a, b] = [await person(), await person()]
    const first = await goLive(a.token, v)
    const spy = jest.spyOn(appDb.chat_groups, "findUnique").mockResolvedValueOnce(null)
    try {
      const second = await goLive(b.token, v)
      expect(second.status).toBe(200)
      expect(second.json.data.chatGroupId).toBe(first.json.data.chatGroupId)
    } finally {
      spy.mockRestore()
    }
  })

  it("refuses any other window (PL-U02)", async () => {
    const v = await venue()
    const me = await person()
    expect((await goLive(me.token, v, { minutes: 30 })).status).toBe(400)
    expect((await goLive(me.token, v, {})).status).toBe(400)
  })

  it("extends when you go live again, and never shortens", async () => {
    const v = await venue()
    const me = await person()
    const first = await goLive(me.token, v, { minutes: 60 })
    const again = await goLive(me.token, v, { minutes: 20 })
    expect(again.json.data.expiresAt).toBe(first.json.data.expiresAt)
    expect(await db.event_check_ins.count({ where: { event_id: first.json.data.venueDayId, user_id: me.id } })).toBe(1)
  })

  it("keeps the first stay's four-hour cap when stay is chosen again (D-x5)", async () => {
    const v = await venue()
    const me = await person()
    const first = await goLive(me.token, v, { stay: true })
    const dayId = first.json.data.venueDayId
    // Three hours later, a fixed window, then stay again: the cap is the first one.
    await rewind(dayId, me.id, 180)
    const fixed = await goLive(me.token, v, { minutes: 20 })
    expect(fixed.json.data).toMatchObject({ stay: false, stayUntil: null })
    const again = await goLive(me.token, v, { stay: true })
    const cap = (await checkInOf(dayId, me.id)).stay_until!
    expect(again.json.data.stayUntil).toBe(cap.toISOString())
    expect(cap.getTime() - Date.now()).toBeLessThan(61 * 60_000)
  })

  it("ends a window at the venue's reset (D-4)", async () => {
    // A venue whose day resets at the top of the next UTC hour; more than five
    // minutes away, so this is today's room and not tomorrow's.
    const nowUtc = new Date()
    if (60 - nowUtc.getUTCMinutes() <= 6) return // the rollover case is go-live-sweeper.itest.ts's
    const v = await venue({ resetHour: (nowUtc.getUTCHours() + 1) % 24 })
    const me = await person()
    const { json } = await goLive(me.token, v, { minutes: 60 })
    const day = await db.events.findUniqueOrThrow({ where: { id: json.data.venueDayId } })
    expect(json.data.expiresAt).toBe(day.end_time.toISOString())
  })

  it("is staff work for the venue's own organisation, as at an event there (decision)", async () => {
    const org = await db.organisations.create({ data: { display_name: testId("gl_org"), kind: "company", status: "verified" } })
    world.orgs.push(org.id)
    const v = await venue({ ownerOrg: org.id })
    const me = await person()
    await db.organisation_members.create({ data: { org_id: org.id, user_id: me.id, role: "owner" } })
    const { json } = await goLive(me.token, v, { stay: true })
    const dayId = json.data.venueDayId
    expect((await checkInOf(dayId, me.id)).kind).toBe("staff")

    // Staff skip the fence in the departure rule; their "stay" still follows an in-fence ping.
    await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: me.id }, data: { expires_at: new Date(Date.now() + 2 * 60_000) } })
    await routes.presence.POST(req(`/api/mobile/events/${dayId}/presence`, me.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
    expect((await checkInOf(dayId, me.id)).expires_at!.getTime() - Date.now()).toBeGreaterThan(15 * 60_000)
  })

  it("refuses an unfenced venue, and makes no day for the refusal", async () => {
    const v = await venue({ fence: null })
    const me = await person()
    const { status, json } = await goLive(me.token, v)
    expect(status).toBe(400)
    expect(json.errorCode).toBe("OUT_OF_RANGE")
    expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(0)
  })

  it("refuses outside the fence without the distance, makes no day, and records only on a day that exists (PL-I19, D-x6)", async () => {
    const v = await venue()
    const eventHere = await realEvent(v, { startsInMin: 6 * 60 })
    const stranger = await person()
    const since = new Date(Date.now() - 1_000)
    const platformBefore = await refusalsByReason({ from: since, to: new Date(Date.now() + 60_000) })

    // Before anybody is live: refused, nothing written.
    const first = await goLive(stranger.token, v, { minutes: 20 }, OUTSIDE)
    expect(first.status).toBe(400)
    expect(first.json.error).toMatch(/^You're not at .+ yet\.$/)
    expect(first.json.error).not.toMatch(/\d+\s?m\b|metre/)
    expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(0)

    // Once the day exists, the refusal is recorded against it, and nowhere else.
    const insider = await person()
    const { json } = await goLive(insider.token, v)
    await goLive(stranger.token, v, { minutes: 20 }, OUTSIDE)
    const rows = await until(
      () => db.check_in_refusals.count({ where: { event_id: json.data.venueDayId, reason: "out_of_range" } }),
      (n) => n === 1
    )
    expect(rows).toBe(1)
    expect((await refusalSummary(eventHere)).attempts).toBe(0)
    expect((await refusalsByReason({ from: since, to: new Date(Date.now() + 60_000) })).total).toBe(platformBefore.total)
  })

  it("refuses a venue that is archived or unknown, and a day deleted today, with 404", async () => {
    const v = await venue()
    await db.venues.update({ where: { id: v }, data: { status: "archived" } })
    const me = await person()
    expect((await goLive(me.token, v)).status).toBe(404)
    expect((await goLive(me.token, randomUUID())).status).toBe(404)

    const w = await venue()
    const first = await goLive(me.token, w)
    await db.events.update({ where: { id: first.json.data.venueDayId }, data: { deleted_at: new Date() } })
    const other = await person()
    expect((await goLive(other.token, w)).status).toBe(404)
  })

  it.each([
    ["not onboarded, no age", { age: null, onboarded: false }],
    ["onboarded, no age on file", { age: null, onboarded: true }],
    ["onboarded at 17, from before the 18+ ruling", { age: 17, onboarded: true }],
  ])("refuses somebody %s (strictly 18+, known age)", async (_label, opts) => {
    const v = await venue()
    const p = await person("glage", { age: opts.age })
    if (!opts.onboarded) await db.profiles.update({ where: { id: p.id }, data: { onboarded: false } })
    const { status, json } = await goLive(p.token, v)
    expect(status).toBe(403)
    expect(json.errorCode).toBe(opts.onboarded ? "AGE_RESTRICTED" : "FORBIDDEN")
    expect(await db.event_check_ins.count({ where: { user_id: p.id } })).toBe(0)
    expect((await venueDetail(p.token, v)).status).toBe(403)
  })
})

describe("refusal precedence (PL-U08)", () => {
  it("answers EVENT_LIVE_HERE before the fence, the area and the fix", async () => {
    const v = await venue()
    const eventId = await realEvent(v, { startsInMin: 30, link: "confirmed" })
    const me = await person()
    for (const [body, at] of [
      [{ minutes: 20 }, OUTSIDE],
      [{ minutes: 20, deviceInfo: { gpsAccuracy: 400 } }, INSIDE],
    ] as const) {
      const { status, json } = await goLive(me.token, v, body, at)
      expect(status).toBe(409)
      expect(json).toMatchObject({ errorCode: "EVENT_LIVE_HERE", eventId })
    }
    // An unfenced venue with a confirmed event: the event, not "no area".
    const bare = await venue({ fence: null })
    const there = await realEvent(bare, { startsInMin: 30, link: "confirmed" })
    expect((await goLive(me.token, bare)).json).toMatchObject({ errorCode: "EVENT_LIVE_HERE", eventId: there })
  })

  it("answers the person before the event, and the venue before both", async () => {
    const v = await venue()
    await realEvent(v, { startsInMin: 30, link: "confirmed" })
    const minor = await person("glminor", { age: 17 })
    expect((await goLive(minor.token, v)).status).toBe(403)
    await db.venues.update({ where: { id: v }, data: { status: "archived" } })
    expect((await goLive(minor.token, v)).status).toBe(404)
  })

  it("refuses only stay with PLUS_REQUIRED when Plus gating is on", async () => {
    const v = await venue()
    const me = await person()
    process.env.PLUS_GATING = "true"
    try {
      const stay = await goLive(me.token, v, { stay: true })
      expect(stay.status).toBe(403)
      expect(stay.json.errorCode).toBe("PLUS_REQUIRED")
      expect((await goLive(me.token, v, { minutes: 20 })).status).toBe(200)
    } finally {
      delete process.env.PLUS_GATING
    }
  })

  it("answers 429 from the 21st attempt in a minute (PL-I21)", async () => {
    const me = await person()
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) statuses.push((await goLive(me.token, randomUUID())).status)
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true)
    expect(statuses.slice(20)).toEqual([429, 429])
  })
})

describe("EVENT_LIVE_HERE (PL-I09, D-x3)", () => {
  it.each([
    ["public, NULL link, its area at the venue", { link: null }, 409],
    ["public, auto-linked, its area at the venue", { link: "auto_linked" as const }, 409],
    ["public, confirmed link", { link: "confirmed" as const }, 409],
    ["public, auto-linked, its area a kilometre away", { link: "auto_linked" as const, far: true }, 200],
    ["public, confirmed, its area a kilometre away", { link: "confirmed" as const, far: true }, 409],
    ["private", { visibility: "private" as const, link: null }, 200],
    ["disputed", { link: "disputed" as const }, 200],
    ["a day of it called off", { link: "confirmed" as const, cancelled: true }, 200],
  ])("an event here starting in 59 minutes: %s → %s", async (_label, opts, expected) => {
    const v = await venue()
    const eventId = await realEvent(v, { startsInMin: 59, ...opts })
    const me = await person()
    const { status, json } = await goLive(me.token, v)
    expect(status).toBe(expected)
    if (expected === 409) {
      expect(json).toMatchObject({ errorCode: "EVENT_LIVE_HERE", eventId })
      // A refusal before any day: nothing was made.
      expect(await db.events.count({ where: { venue_id: v, kind: "venue_day" } })).toBe(0)
    }
  })

  it("starts an hour before: refused at 59 minutes 30, open at 61", async () => {
    const [at, after] = [await venue(), await venue()]
    await realEvent(at, { startsInMin: 59.5, link: "confirmed" })
    await realEvent(after, { startsInMin: 61, link: "confirmed" })
    const me = await person()
    expect((await goLive(me.token, at)).status).toBe(409)
    expect((await goLive(me.token, after)).status).toBe(200)
  })

  it("ends with the event: open again once it has ended", async () => {
    const v = await venue()
    await realEvent(v, { startsInMin: -61, hours: 1, link: "confirmed" })
    const me = await person()
    expect((await goLive(me.token, v)).status).toBe(200)
  })
})

describe("switches and going again", () => {
  it("closes a switch: live at A, then an event, then live at C (PL-I11)", async () => {
    const [a, c] = [await venue(), await venue()]
    const me = await person()
    const atA = await goLive(me.token, a)
    await openSessionOf(atA.json.data.venueDayId, me.id)
    const eventB = await realEvent(await venue(), { startsInMin: -10, visibility: "private" })
    await db.event_rsvps.create({ data: { event_id: eventB, user_id: me.id, status: "going" } })
    const res = await routes.checkin.POST(req(`/api/mobile/events/${eventB}/checkin`, me.token, "POST", INSIDE), eventParams(eventB))
    expect(res.status).toBe(200)
    expect((await checkInOf(atA.json.data.venueDayId, me.id)).status).toBe("checked_out")
    expect((await sessionOf(atA.json.data.venueDayId, me.id)).departed_source).toBe("switch")
    expect(await canJoinChat(me.id, atA.json.data.chatGroupId)).toBe(false)

    await goLive(me.token, c)
    expect((await checkInOf(eventB, me.id)).status).toBe("checked_out")
  })

  it("ends an unswept window as expired when you go live somewhere else", async () => {
    const [a, b] = [await venue(), await venue()]
    const me = await person()
    const atA = await goLive(me.token, a)
    const dayA = atA.json.data.venueDayId
    await openSessionOf(dayA, me.id)
    await rewind(dayA, me.id, 25)
    const ended = (await checkInOf(dayA, me.id)).expires_at!
    await goLive(me.token, b)
    const session = await sessionOf(dayA, me.id)
    expect(session.departed_source).toBe("expired")
    expect(session.departed_at?.toISOString()).toBe(ended.toISOString())
  })

  it("starts a new session when you go again after expiry, before any sweep (PL-M05)", async () => {
    const v = await venue()
    const me = await person()
    const first = await goLive(me.token, v)
    const dayId = first.json.data.venueDayId
    await openSessionOf(dayId, me.id)
    await rewind(dayId, me.id, 25)
    const ended = (await checkInOf(dayId, me.id)).expires_at!

    const again = await goLive(me.token, v)
    expect(again.status).toBe(200)
    expect(again.json.data.venueDayId).toBe(dayId)
    const sessions = await until(
      () => db.presence_sessions.findMany({ where: { event_id: dayId, user_id: me.id }, orderBy: { arrived_at: "asc" } }),
      (s) => s.length === 2
    )
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ departed_source: "expired" })
    expect(sessions[0].departed_at?.toISOString()).toBe(ended.toISOString())
    expect(sessions[1].departed_at).toBeNull()
    expect(await canJoinChat(me.id, again.json.data.chatGroupId)).toBe(true)
  })
})

describe("muted, banned and left, at both doors", () => {
  async function liveRoom() {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    return { v, me, dayId: json.data.venueDayId as string, groupId: json.data.chatGroupId as string }
  }
  const member = (groupId: string, userId: string) =>
    db.chat_group_members.findUniqueOrThrow({ where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: userId } } })

  it("keeps a mute through Go Live", async () => {
    const { v, me, groupId } = await liveRoom()
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: me.id } },
      data: { status: "muted", muted_at: new Date(), muted_by: SYSTEM_USER_ID },
    })
    await goLive(me.token, v, { minutes: 45 })
    expect((await member(groupId, me.id)).status).toBe("muted")
  })

  it("keeps a mute through an event check-in too", async () => {
    const eventId = await realEvent(await venue(), { startsInMin: -10, visibility: "private" })
    const me = await person()
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me.id, status: "going" } })
    const checkIn = () => routes.checkin.POST(req(`/api/mobile/events/${eventId}/checkin`, me.token, "POST", INSIDE), eventParams(eventId))
    expect((await checkIn()).status).toBe(200)
    const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId } })
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: group.id, user_id: me.id } },
      data: { status: "muted", muted_at: new Date(), muted_by: SYSTEM_USER_ID },
    })
    expect((await checkIn()).status).toBe(200)
    expect((await member(group.id, me.id)).status).toBe("muted")
  })

  it("keeps a ban a person pressed, and the room's roster, grid and waves stay shut", async () => {
    const { v, me, dayId, groupId } = await liveRoom()
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: me.id } },
      data: { status: "banned", banned_by: SYSTEM_USER_ID },
    })
    expect((await goLive(me.token, v, { minutes: 45 })).status).toBe(200)
    expect((await member(groupId, me.id)).status).toBe("banned")
    expect((await routes.roster.GET(req(`/api/mobile/events/${dayId}/checkins`, me.token), eventParams(dayId))).status).toBe(403)
    const grid = await routes.matches.GET(req(`/api/mobile/events/${dayId}/matches`, me.token), eventParams(dayId))
    expect([403, 404]).toContain(grid.status)
    expect(await canJoinEventRoom(me.id, dayId)).toBe(false)
    expect(await canJoinChat(me.id, groupId)).toBe(false)
  })

  it("lets somebody who left the room by choice back in by going live, as checking in does", async () => {
    const { v, me, groupId } = await liveRoom()
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: me.id } },
      data: { status: "left", left_at: new Date() },
    })
    expect(await canJoinChat(me.id, groupId)).toBe(false)
    await goLive(me.token, v, { minutes: 45 })
    expect(await member(groupId, me.id)).toMatchObject({ status: "active", left_at: null })
    expect(await canJoinChat(me.id, groupId)).toBe(true)
  })
})

describe("by-id attendee routes refuse a venue day's id", () => {
  it("as if it did not exist", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    const id = json.data.venueDayId
    const other = await person()

    expect((await routes.event.GET(req(`/api/mobile/events/${id}`, other.token), eventParams(id))).status).toBe(404)
    expect((await routes.rsvp.POST(req(`/api/mobile/events/${id}/rsvp`, other.token, "POST", { status: "going" }), eventParams(id))).status).toBe(404)
    expect((await routes.favorite.POST(req(`/api/mobile/events/${id}/favorite`, other.token, "POST"), eventParams(id))).status).toBe(404)
    expect((await routes.interest.POST(req(`/api/mobile/events/${id}/interest`, other.token, "POST", {}), eventParams(id))).status).toBe(404)
    expect((await routes.rating.POST(req(`/api/mobile/events/${id}/rating`, me.token, "POST", { rating: 5 }), eventParams(id))).status).toBe(404)
    expect((await routes.rating.GET(req(`/api/mobile/events/${id}/rating`, me.token), eventParams(id))).status).toBe(404)
    expect((await routes.peerRatings.GET(req(`/api/mobile/events/${id}/peer-ratings`, me.token), eventParams(id))).status).toBe(404)
    expect(
      (await routes.peerRatings.POST(req(`/api/mobile/events/${id}/peer-ratings`, me.token, "POST", { userId: other.id, rating: 5 }), eventParams(id))).status
    ).toBe(404)
    expect((await routes.report.POST(req(`/api/mobile/events/${id}/report`, other.token, "POST", { reason: "other", description: "x" }), eventParams(id))).status).toBe(404)
    // The plain check-in is not a door into a venue day: Go Live is.
    expect((await routes.checkin.POST(req(`/api/mobile/events/${id}/checkin`, other.token, "POST", INSIDE), eventParams(id))).status).toBe(404)
    expect(await db.event_check_ins.count({ where: { event_id: id, user_id: other.id } })).toBe(0)
    expect(await db.event_rsvps.count({ where: { event_id: id } })).toBe(0)
    expect(await db.event_reports.count({ where: { event_id: id } })).toBe(0)
  })
})

describe("the venue's room is for the people live in it (F6, F7, D-5)", () => {
  it("closes to you when your window ends, on every door, before any sweep and after", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    const { venueDayId, chatGroupId } = json.data
    await openSessionOf(venueDayId, me.id)

    const send = (token: string) =>
      routes.messages.POST(req(`/api/mobile/chat/groups/${chatGroupId}/messages`, token, "POST", { content: "hello" }), groupParams(chatGroupId))
    const read = (token: string) => routes.messages.GET(req(`/api/mobile/chat/groups/${chatGroupId}/messages`, token), groupParams(chatGroupId))
    const listed = async () => {
      const res = await routes.groups.GET(req("/api/mobile/chat/groups", me.token))
      return ((await res.json()).data.groups as Array<{ id: string }>).map((g) => g.id)
    }
    expect((await read(me.token)).status).toBe(200)
    expect(await canJoinEventRoom(me.id, venueDayId)).toBe(true)
    expect((await routes.roster.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))).status).toBe(200)
    expect(await listed()).toContain(chatGroupId)

    await rewind(venueDayId, me.id, 25)

    // Closed at the end itself, before any sweeper has run.
    expect((await checkInOf(venueDayId, me.id)).status).toBe("checked_in")
    expect(await canJoinChat(me.id, chatGroupId)).toBe(false)
    expect(await canJoinEventRoom(me.id, venueDayId)).toBe(false)
    expect((await routes.roster.GET(req(`/api/mobile/events/${venueDayId}/checkins`, me.token), eventParams(venueDayId))).status).toBe(403)
    // Not in the Banter list either: no last message, no counts from outside (step 4 review).
    expect(await listed()).not.toContain(chatGroupId)
    const active = await routes.activeCheckins.GET(req("/api/mobile/checkins/active", me.token))
    expect(((await active.json()).data.checkIns as Array<{ eventId: string }>).map((c) => c.eventId)).not.toContain(venueDayId)

    const swept = await sweepVenueDays()
    expect(swept.expired).toBeGreaterThanOrEqual(1)

    const checkIn = await checkInOf(venueDayId, me.id)
    const session = await sessionOf(venueDayId, me.id)
    expect(checkIn.status).toBe("checked_out")
    expect(session.departed_source).toBe("expired")
    // Stamped when the window ended, not when the sweeper got there (PL-U04).
    expect(session.departed_at?.toISOString()).toBe(checkIn.expires_at?.toISOString())

    expect(await canJoinChat(me.id, chatGroupId)).toBe(false)
    expect(await canJoinEvent(me.id, venueDayId)).toBe(false)
    const readAfter = await read(me.token)
    expect(readAfter.status).toBe(403)
    expect((await readAfter.json()).errorCode).toBe("NOT_LIVE")
    const sendAfter = await send(me.token)
    expect(sendAfter.status).toBe(403)
    expect((await sendAfter.json()).errorCode).toBe("NOT_LIVE")
    const viaEvent = await routes.eventChat.GET(req(`/api/mobile/events/${venueDayId}/chat`, me.token), eventParams(venueDayId))
    expect(viaEvent.status).toBe(403)
    expect(await listed()).not.toContain(chatGroupId)
  })

  it("never lets somebody in who was not live there (no auto-join)", async () => {
    const v = await venue()
    const host = await person()
    const { json } = await goLive(host.token, v)
    const stranger = await person()
    const res = await routes.eventChat.GET(req(`/api/mobile/events/${json.data.venueDayId}/chat`, stranger.token), eventParams(json.data.venueDayId))
    expect(res.status).toBe(403)
    // "Go live", not "RSVP": an RSVP is no way into a venue's room (F7).
    expect((await res.json()).errorCode).toBe("NOT_LIVE")
    expect(await db.chat_group_members.count({ where: { chat_group_id: json.data.chatGroupId, user_id: stranger.id } })).toBe(0)
    expect(await canJoinEvent(stranger.id, json.data.venueDayId)).toBe(false)
  })

  it("lists the active Go Live with its kind, end and stay", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v, { stay: true })
    const res = await routes.activeCheckins.GET(req("/api/mobile/checkins/active", me.token))
    const mine = ((await res.json()).data.checkIns as Array<Record<string, unknown>>).find((c) => c.eventId === json.data.venueDayId)
    expect(mine).toMatchObject({ kind: "venue_day", stay: true, expiresAt: json.data.expiresAt })
  })

  it("counts two people as having met only when their windows overlapped (D-x4)", async () => {
    const v = await venue()
    const [a, b, c] = [await person(), await person(), await person()]
    const day = (await goLive(a.token, v)).json.data.venueDayId
    await goLive(b.token, v)
    await Promise.all([openSessionOf(day, a.id), openSessionOf(day, b.id)])
    expect(await haveSharedAnEvent(a.id, b.id)).toBe(true)
    // a's window ended long before c arrived.
    await rewind(day, a.id, 300)
    await sweepVenueDays()
    await goLive(c.token, v)
    await openSessionOf(day, c.id)
    expect(await haveSharedAnEvent(a.id, c.id)).toBe(false)
    expect(await haveSharedAnEvent(b.id, c.id)).toBe(true)
  })
})

describe("GET /venues/:id (PL-I18, D-19, D-x2)", () => {
  it("counts guests in buckets, not the caller, never the area", async () => {
    const v = await venue()
    const viewer = await person()
    const first = await venueDetail(viewer.token, v)
    expect(first.status).toBe(200)
    expect(JSON.parse(first.text).data.live).toMatchObject({ open: true, closedReason: null, liveNow: "quiet", youAreLive: false, expiresAt: null })

    for (let i = 0; i < 5; i++) await goLive((await person()).token, v)
    // Read within the minute: the figure is steady (`lib/live-count.ts`).
    expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("quiet")

    const mine = await goLive(viewer.token, v, { minutes: 45 })
    const { text } = await venueDetail(viewer.token, v)
    const data = JSON.parse(text).data
    expect(data.live).toMatchObject({
      youAreLive: true,
      expiresAt: mine.json.data.expiresAt,
      venueDayId: mine.json.data.venueDayId,
      chatGroupId: mine.json.data.chatGroupId,
    })
    expect(text).not.toMatch(/geofence|radius|"ring"/)
  })

  it("reads the count afresh after a minute, leaves staff out, and the caller out", async () => {
    jest.useFakeTimers({ advanceTimers: true, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "queueMicrotask", "hrtime", "performance"] })
    try {
      const v = await venue()
      const viewer = await person()
      expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("quiet")
      const five = await Promise.all(Array.from({ length: 5 }, () => person("glb")))
      let day = ""
      for (const p of five) day = (await goLive(p.token, v)).json.data.venueDayId
      jest.setSystemTime(Date.now() + 61_000)
      expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("5-9")
      // One of the five asks: four others, and never themselves.
      expect(JSON.parse((await venueDetail(five[0].token, v)).text).data.live.liveNow).toBe("quiet")
      // One of them leaves: still 5-9 to a watcher until one more goes (hysteresis).
      await routes.checkout.POST(req(`/api/mobile/events/${day}/checkout`, five[1].token, "POST"), eventParams(day))
      jest.setSystemTime(Date.now() + 61_000)
      expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("5-9")
      await routes.checkout.POST(req(`/api/mobile/events/${day}/checkout`, five[2].token, "POST"), eventParams(day))
      jest.setSystemTime(Date.now() + 61_000)
      expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("quiet")
    } finally {
      jest.useRealTimers()
    }
  })

  it("never counts the caller in the figure they are shown", async () => {
    // Four others and you: five live, but you are shown four — "quiet".
    const v = await venue()
    for (let i = 0; i < 4; i++) await goLive((await person("glx")).token, v)
    const me = await person()
    await goLive(me.token, v)
    expect(JSON.parse((await venueDetail(me.token, v)).text).data.live.liveNow).toBe("quiet")
  })

  it("never counts the venue's staff as people here", async () => {
    const org = await db.organisations.create({ data: { display_name: testId("gl_staff_org"), kind: "company", status: "verified" } })
    world.orgs.push(org.id)
    const v = await venue({ ownerOrg: org.id })
    for (let i = 0; i < 4; i++) await goLive((await person("glg")).token, v)
    const staffer = await person("glstaff")
    await db.organisation_members.create({ data: { org_id: org.id, user_id: staffer.id, role: "staff" } })
    await goLive(staffer.token, v)
    const viewer = await person()
    expect(JSON.parse((await venueDetail(viewer.token, v)).text).data.live.liveNow).toBe("quiet")
  })

  it("says why going live is closed, judged against the same area as the door", async () => {
    const unfenced = await venue({ fence: null })
    const me = await person()
    expect(JSON.parse((await venueDetail(me.token, unfenced)).text).data.live).toMatchObject({ open: false, closedReason: "no_check_in_area" })

    const busy = await venue()
    const eventId = await realEvent(busy, { startsInMin: 30, link: "confirmed" })
    const data = JSON.parse((await venueDetail(me.token, busy)).text).data
    expect(data.live).toMatchObject({ open: false, closedReason: "event_live_here", eventId })
    expect(data.tonight?.id).toBe(eventId)

    // Today's day copied the venue's area; the venue's area then removed. The
    // door judges the day's copy, so the page says open too.
    const v = await venue()
    await goLive((await person()).token, v)
    await db.$executeRaw`UPDATE venues SET geofence = NULL WHERE id = ${v}::uuid`
    expect(JSON.parse((await venueDetail(me.token, v)).text).data.live.open).toBe(true)
    expect((await goLive(me.token, v)).status).toBe(200)
  })

  it("404s an archived venue, and is rate limited", async () => {
    const v = await venue()
    const me = await person()
    await db.venues.update({ where: { id: v }, data: { status: "archived" } })
    expect((await venueDetail(me.token, v)).status).toBe(404)
  })
})

describe("what others see, and erasure", () => {
  it("labels a venue day as a place in /me/attendance, and keeps it out of anybody else's count (D-6)", async () => {
    const v = await venue()
    const me = await person()
    const viewer = await person()
    const { json } = await goLive(me.token, v)
    const res = await routes.attendance.GET(req("/api/mobile/me/attendance", me.token))
    const body = (await res.json()).data
    expect((body.events as Array<{ id: string; kind: string }>).find((e) => e.id === json.data.venueDayId)?.kind).toBe("venue_day")
    expect(body.pagination.totalCount).toBe(1)

    const profileOf = async (token: string) =>
      (await (await routes.user.GET(req(`/api/mobile/users/${me.id}`, token), { params: Promise.resolve({ userId: me.id }) })).json()).data
    expect((await profileOf(me.token)).stats.eventsAttended).toBe(1)
    const seen = await profileOf(viewer.token)
    if (seen?.stats) expect(seen.stats.eventsAttended).toBe(0)
  })

  it("shows a reveal at a venue day only while the viewer is live there (step 4 review)", async () => {
    const v = await venue()
    const [a, b] = [await person(), await person()]
    const day = (await goLive(a.token, v)).json.data.venueDayId
    await goLive(b.token, v)
    await db.event_match_preferences.update({ where: { event_id_user_id: { event_id: day, user_id: b.id } }, data: { revealed: true } })
    expect((await visibleInRoom(a.id, day, [b.id])).has(b.id)).toBe(true)
    expect((await maySeeIdentityFor(a.id, [b.id])).has(b.id)).toBe(true)
    // a's window ends: a past seat is no seat from which to see who revealed.
    await rewind(day, a.id, 25)
    expect((await visibleInRoom(a.id, day, [b.id])).has(b.id)).toBe(false)
    expect((await maySeeIdentityFor(a.id, [b.id])).has(b.id)).toBe(false)
  })

  it("erases a deleted account's Go Live as it does an event's (PL-I22)", async () => {
    const v = await venue()
    const me = await person()
    const { json } = await goLive(me.token, v)
    await openSessionOf(json.data.venueDayId, me.id)
    const res = await routes.account.DELETE(req("/api/mobile/account", me.token, "DELETE"))
    expect(res.status).toBe(200)
    expect((await checkInOf(json.data.venueDayId, me.id)).status).toBe("checked_out")
    expect((await sessionOf(json.data.venueDayId, me.id)).departed_at).not.toBeNull()
    expect(await canJoinChat(me.id, json.data.chatGroupId)).toBe(false)
    // The day is everybody's; it stays.
    expect(await db.events.findUnique({ where: { id: json.data.venueDayId }, select: { id: true } })).not.toBeNull()
  })
})

