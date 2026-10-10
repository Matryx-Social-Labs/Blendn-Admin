import { randomUUID } from "crypto"
import jwt from "jsonwebtoken"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { inviteTokenFor } from "@/lib/friends"
import { plusRequired, referralRef, trialRef } from "@/lib/plus"
import { flushProductEvents } from "@/lib/product-events"

import { closeDb, db, makeEvent, makeUser, occurrenceOf, testId } from "./helpers"
import { checkInOf, cleanupWorld, eventParams, goLive, INSIDE, person, req, routes, venue, world } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const plusRoute = require("@/app/api/mobile/me/plus/route") as typeof import("@/app/api/mobile/me/plus/route")
const paywallRoute = require("@/app/api/mobile/me/plus/paywall-events/route") as typeof import("@/app/api/mobile/me/plus/paywall-events/route")
const friendRequests = require("@/app/api/mobile/friends/requests/route") as typeof import("@/app/api/mobile/friends/requests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Blendn+ gates, driven through the real routes against real Postgres
 * (step 11; TQ-A13: MN-U01, MN-I07..I10, MN-C01; D-11).
 *
 * The fixture venue is in Bengaluru (`go-live-world`). `PLUS_GATING` is set
 * per case and cleared after. Plus is written straight into `entitlements`
 * here, the way the webhook leaves it — the webhook itself is
 * `revenuecat-webhook.itest.ts`.
 */

const DAY = 86_400_000
const hosts: string[] = []
const extraEvents: string[] = []

afterEach(() => {
  delete process.env.PLUS_GATING
})

afterAll(async () => {
  await db.entitlements.deleteMany({ where: { subject_kind: "user", subject_id: { in: world.users } } })
  await db.product_events.deleteMany({ where: { user_id: { in: world.users } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: extraEvents } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: extraEvents } } })
  await db.events.deleteMany({ where: { id: { in: extraEvents } } })
  await db.user.deleteMany({ where: { id: { in: hosts } } })
  await cleanupWorld()
  await closeDb()
}, 120_000)

async function plus(userId: string, o: { product?: "plus" | "night_pass"; from?: number; until?: number } = {}) {
  await db.entitlements.create({
    data: {
      subject_kind: "user",
      subject_id: userId,
      product: o.product ?? "plus",
      source: "apple",
      external_ref: `itest_txn_${randomUUID()}`,
      starts_at: new Date(o.from ?? Date.now() - DAY),
      expires_at: new Date(o.until ?? Date.now() + 30 * DAY),
    },
  })
}

/** Their one trial, already had and over: the gate has nothing left to give them. */
async function trialUsed(userId: string) {
  await db.entitlements.create({
    data: {
      subject_kind: "user",
      subject_id: userId,
      product: "plus",
      source: "grant",
      external_ref: trialRef(userId),
      starts_at: new Date(Date.now() - 30 * DAY),
      expires_at: new Date(Date.now() - 16 * DAY),
    },
  })
}

/** `n` nights out, in `city`, the newest `daysAgo` days ago and one more day back for each older one. */
async function nightsOut(userId: string, n: number, o: { city?: string; daysAgo?: number } = {}) {
  if (hosts.length === 0) hosts.push(await makeUser(testId("plus_host"), "organizer"))
  for (let i = 0; i < n; i++) {
    const eventId = await makeEvent(hosts[0])
    extraEvents.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { city: o.city ?? "Bengaluru" } })
    const at = new Date(Date.now() - ((o.daysAgo ?? 1) + i) * DAY)
    await db.event_check_ins.create({
      data: { event_id: eventId, occurrence_id: await occurrenceOf(eventId), user_id: userId, kind: "attendee", status: "checked_out", check_in_time: at, created_at: at },
    })
  }
}

const grants = (userId: string) =>
  db.entitlements.findMany({ where: { subject_kind: "user", subject_id: userId, source: "grant" }, orderBy: { created_at: "asc" } })

async function attendance(token: string, query = "") {
  const res = await routes.attendance.GET(req(`/api/mobile/me/attendance${query}`, token))
  return (await res.json()) as { data: { events: unknown[]; lockedCount: number; pagination: { totalCount: number } } }
}

describe("Go Live 'stay' (the stay-live gate)", () => {
  it("is everyone's in a city's launch season, and Plus's once the city is gated", async () => {
    const v = await venue()
    const me = await person()
    expect((await goLive(me.token, v, { stay: true })).status).toBe(200)

    process.env.PLUS_GATING = "Mumbai,Delhi"
    expect((await goLive(me.token, v, { stay: true })).status).toBe(200)

    process.env.PLUS_GATING = " mumbai , BENGALURU "
    const other = await person()
    const stay = await goLive(other.token, v, { stay: true })
    expect([stay.status, stay.json.errorCode]).toEqual([403, "PLUS_REQUIRED"])
    // The free windows are never Plus.
    expect((await goLive(other.token, v, { minutes: 20 })).status).toBe(200)
  })

  it("opens to Plus and to a live Night Pass, and not to one that ended", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const v = await venue()
    const [subscriber, pass, lapsed] = [await person(), await person(), await person()]
    await plus(subscriber.id)
    await plus(pass.id, { product: "night_pass", until: Date.now() + 3_600_000 })
    await plus(lapsed.id, { from: Date.now() - 40 * DAY, until: Date.now() - 1000 })
    expect((await goLive(subscriber.token, v, { stay: true })).status).toBe(200)
    expect((await goLive(pass.token, v, { stay: true })).status).toBe(200)
    expect((await goLive(lapsed.token, v, { stay: true })).status).toBe(403)
  })

  it("is not opened by anything the client says: a header, a query flag, a forged claim (MN-I10)", async () => {
    process.env.PLUS_GATING = "true"
    const v = await venue()
    const me = await person()
    const forged = jwt.sign(
      { userId: me.id, email: `${me.id}@itest.invalid`, type: "access", plus: true, entitlements: ["plus"], role: "app_admin" },
      process.env.MOBILE_JWT_SECRET!,
      { expiresIn: "15m" }
    )
    for (const [token, url, headers] of [
      [me.token, `/api/mobile/venues/${v}/live`, { "x-plus": "true" }],
      [me.token, `/api/mobile/venues/${v}/live?plus=1`, {}],
      [forged, `/api/mobile/venues/${v}/live`, {}],
    ] as const) {
      const res = await routes.live.POST(req(url, token, "POST", { ...INSIDE, stay: true }, headers), { params: Promise.resolve({ venueId: v }) })
      expect(res.status).toBe(403)
      expect(((await res.json()) as { errorCode: string }).errorCode).toBe("PLUS_REQUIRED")
    }
  })

  it("is asked last: an unknown venue is still a 404 and outside is still OUT_OF_RANGE (the paywall only where stay would work)", async () => {
    process.env.PLUS_GATING = "true"
    const me = await person()
    expect((await goLive(me.token, randomUUID(), { stay: true })).status).toBe(404)
    const outside = await goLive(me.token, await venue(), { stay: true }, { latitude: INSIDE.latitude + 0.01, longitude: INSIDE.longitude })
    expect(outside.json.errorCode).toBe("OUT_OF_RANGE")
  })

  it("stops carrying a stay once Plus lapses in a gated city: the window ends at most 20 minutes on (D-11)", async () => {
    const v = await venue()
    const [lapses, keeps] = [await person(), await person()]
    await plus(keeps.id)
    await trialUsed(lapses.id)
    const days = []
    for (const p of [lapses, keeps]) days.push((await goLive(p.token, v, { stay: true })).json.data.venueDayId as string)
    process.env.PLUS_GATING = "Bengaluru"
    const soon = new Date(Date.now() + 2 * 60_000)
    for (const [p, dayId] of [[lapses, days[0]], [keeps, days[1]]] as const) {
      await db.event_check_ins.updateMany({ where: { event_id: dayId, user_id: p.id }, data: { expires_at: soon } })
      await routes.presence.POST(req(`/api/mobile/events/${dayId}/presence`, p.token, "POST", { ...INSIDE, accuracy: 10 }), eventParams(dayId))
    }
    expect((await checkInOf(days[0], lapses.id)).expires_at!.getTime()).toBe(soon.getTime())
    expect((await checkInOf(days[1], keeps.id)).expires_at!.getTime() - Date.now()).toBeGreaterThan(15 * 60_000)
  })
})

describe("the trial and the referral month: once each, at the gate (MN-I08, MN-I09)", () => {
  it("gives someone who came out in the last 90 days 14 days of Plus the first time the gate would stop them, and never again", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const v = await venue()
    const regular = await person()
    await nightsOut(regular.id, 1, { daysAgo: 89 })
    const before = Date.now()
    expect((await goLive(regular.token, v, { stay: true })).status).toBe(200)
    const [trial] = await grants(regular.id)
    expect(trial).toMatchObject({ product: "plus", external_ref: trialRef(regular.id) })
    expect(trial.expires_at!.getTime() - trial.starts_at.getTime()).toBe(1_209_600_000)
    expect(trial.starts_at.getTime()).toBeGreaterThanOrEqual(before)

    // Over: no second one, however it is asked, or how many at once.
    await db.entitlements.update({ where: { id: trial.id }, data: { starts_at: new Date(Date.now() - 20 * DAY), expires_at: new Date(Date.now() - 6 * DAY) } })
    const answers = await Promise.all([plusRequired(regular.id, "Bengaluru"), plusRequired(regular.id, "Bengaluru")])
    expect(answers).toEqual([true, true])
    expect(await grants(regular.id)).toHaveLength(1)
  })

  it("lets two first refusals at once both see the one trial", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const regular = await person()
    await nightsOut(regular.id, 1)
    expect(await Promise.all([plusRequired(regular.id, "Bengaluru"), plusRequired(regular.id, "Bengaluru")])).toEqual([false, false])
    expect(await grants(regular.id)).toHaveLength(1)
  })

  it("gives none to someone who has not come out lately, or ever", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const [never, longAgo] = [await person(), await person()]
    await nightsOut(longAgo.id, 1, { daysAgo: 91 })
    expect(await plusRequired(never.id, "Bengaluru")).toBe(true)
    expect(await plusRequired(longAgo.id, "Bengaluru")).toBe(true)
    expect(await grants(never.id)).toHaveLength(0)
    expect(await grants(longAgo.id)).toHaveLength(0)
  })

  it("is nothing in a launch-season city: no trial is used up where nothing is locked", async () => {
    process.env.PLUS_GATING = "Mumbai"
    const regular = await person()
    await nightsOut(regular.id, 1)
    expect(await plusRequired(regular.id, "Bengaluru")).toBe(false)
    expect(await grants(regular.id)).toHaveLength(0)
  })

  it("pays one month once three people who joined through your link have checked in since — people, not check-ins", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const inviter = await person("plusinviter")
    const token = await inviteTokenFor(inviter.id)
    const friends = await Promise.all([1, 2, 3, 4].map(() => person("plusfriend")))
    for (const f of friends) {
      const res = await friendRequests.POST(req("/api/mobile/friends/requests", f.token, "POST", { token }))
      expect(res.status).toBe(200)
    }
    expect(await db.referrals.count({ where: { inviter_id: inviter.id } })).toBe(4)
    // They joined ten days ago, so every night below is after joining — but the one moved after.
    await db.referrals.updateMany({ where: { inviter_id: inviter.id }, data: { created_at: new Date(Date.now() - 10 * DAY) } })

    // Two came out after joining, one of them twice (three check-ins); one only BEFORE joining. Two people: not yet.
    await nightsOut(friends[0].id, 2, { daysAgo: 0 })
    await nightsOut(friends[1].id, 1, { daysAgo: 0 })
    await db.referrals.update({ where: { invitee_id: friends[2].id }, data: { created_at: new Date(Date.now() + DAY) } })
    await nightsOut(friends[2].id, 1, { daysAgo: 0 })
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(true)
    expect(await grants(inviter.id)).toHaveLength(0)

    // The third person. Then a fourth changes nothing.
    await nightsOut(friends[3].id, 1, { daysAgo: 0 })
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(false)
    const [month] = await grants(inviter.id)
    expect(month.external_ref).toBe(referralRef(inviter.id))
    const start = month.starts_at
    const oneMonthOn = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    oneMonthOn.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(oneMonthOn.getUTCFullYear(), oneMonthOn.getUTCMonth() + 1, 0)).getUTCDate()))
    oneMonthOn.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds())
    expect(month.expires_at!.toISOString()).toBe(oneMonthOn.toISOString())
    await db.entitlements.update({ where: { id: month.id }, data: { expires_at: new Date(Date.now() - 1000), starts_at: new Date(Date.now() - 2000) } })
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(true)
    expect(await grants(inviter.id)).toHaveLength(1)
  })

  it("never counts a person for two inviters, or anyone for themselves", async () => {
    const [a, b, joiner] = [await person(), await person(), await person()]
    for (const inviter of [a, b]) {
      await friendRequests.POST(req("/api/mobile/friends/requests", joiner.token, "POST", { token: await inviteTokenFor(inviter.id) }))
    }
    expect(await db.referrals.findUnique({ where: { invitee_id: joiner.id } })).toMatchObject({ inviter_id: a.id })
    const self = await friendRequests.POST(req("/api/mobile/friends/requests", a.token, "POST", { token: await inviteTokenFor(a.id) }))
    expect(self.status).toBe(400)
    expect(await db.referrals.count({ where: { inviter_id: a.id, invitee_id: a.id } })).toBe(0)
  })
})

describe("night history beyond 3 (the history gate)", () => {
  it("shows the latest 3 and counts the rest as locked where Plus is gated; all of them with Plus or in a launch season", async () => {
    const me = await person()
    await nightsOut(me.id, 5, { daysAgo: 100 })
    const open = await attendance(me.token)
    expect([open.data.events.length, open.data.lockedCount, open.data.pagination.totalCount]).toEqual([5, 0, 5])

    process.env.PLUS_GATING = "Bengaluru"
    const locked = await attendance(me.token)
    expect([locked.data.events.length, locked.data.lockedCount, locked.data.pagination.totalCount]).toEqual([3, 2, 3])
    expect((await attendance(me.token, "?page=2&limit=2")).data.events).toHaveLength(1)
    expect((await attendance(me.token, "?page=3&limit=2")).data.events).toHaveLength(0)

    await plus(me.id)
    const paid = await attendance(me.token)
    expect([paid.data.events.length, paid.data.lockedCount]).toEqual([5, 0])
  })

  it("locks nothing for 3 nights or fewer, and gives away no trial over it", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const me = await person()
    await nightsOut(me.id, 3, { daysAgo: 0 })
    const res = await attendance(me.token)
    expect([res.data.events.length, res.data.lockedCount]).toEqual([3, 0])
    expect(await grants(me.id)).toHaveLength(0)
  })
})

describe("GET /me/plus and the paywall's events (MN-C01)", () => {
  async function status(token: string) {
    const res = await plusRoute.GET(req("/api/mobile/me/plus", token))
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    return ((await res.json()) as { data: Record<string, unknown> }).data
  }

  it("says what is held and until when, a Night Pass included", async () => {
    const [none, sub, pass] = [await person(), await person(), await person()]
    await plus(sub.id, { until: Date.parse("2036-01-01T00:00:00Z") })
    await plus(pass.id, { product: "night_pass", until: Date.now() + 3_600_000 })
    expect(await status(none.token)).toEqual({ active: false, product: null, source: null, expiresAt: null })
    expect(await status(sub.token)).toEqual({ active: true, product: "plus", source: "apple", expiresAt: "2036-01-01T00:00:00.000Z" })
    expect(await status(pass.token)).toMatchObject({ active: true, product: "night_pass" })
  })

  it("records each step once a day per trigger, and refuses anything off the list", async () => {
    const me = await person()
    const send = (body: unknown) => paywallRoute.POST(req("/api/mobile/me/plus/paywall-events", me.token, "POST", body))
    for (const body of [
      { event: "shown", trigger: "go_live_expiry" },
      { event: "shown", trigger: "go_live_expiry" },
      { event: "shown", trigger: "recap" },
      { event: "dismissed", trigger: "go_live_expiry" },
    ]) {
      expect((await send(body)).status).toBe(200)
    }
    expect((await send({ event: "unlock", trigger: "go_live_expiry" })).status).toBe(400)
    expect((await send({ event: "shown", trigger: "who_liked_you" })).status).toBe(400)
    await flushProductEvents()
    const rows = await db.product_events.findMany({ where: { user_id: me.id, name: { startsWith: "paywall_" } }, select: { name: true, entity_kind: true }, orderBy: { name: "asc" } })
    expect(rows.map((r) => `${r.name}:${r.entity_kind}`).sort()).toEqual([
      "paywall_dismissed:go_live_expiry",
      "paywall_shown:go_live_expiry",
      "paywall_shown:recap",
    ])
  })
})
