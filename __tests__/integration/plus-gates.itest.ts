import { randomUUID } from "crypto"
import jwt from "jsonwebtoken"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// The dashboard's session, for the admin's grant (SCRUM-583).
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { endPlusGrant, grantPlus, personPlus } from "@/lib/billing-actions"
import { hasEntitlement } from "@/lib/entitlements"
import { inviteTokenFor } from "@/lib/friends"
import { hasPlus, plusRequired, threeOnDistinctEvents, trialRef } from "@/lib/plus"
import { flushProductEvents } from "@/lib/product-events"

import { closeDb, db, makeEvent, makeUser, occurrenceOf, refusingWrites, testId } from "./helpers"
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

const audits = (userId: string) =>
  db.audit_logs.findMany({ where: { resource: "user", resource_id: userId }, select: { action: true, user_id: true, details: true } })

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

  it("knows a city by any of its names, and a place with no city is not a way round it (review L6)", async () => {
    process.env.PLUS_GATING = `Bangalore:${TODAY}`
    const v = await venue()
    const me = await person()
    expect((await goLive(me.token, v, { stay: true })).json.errorCode).toBe("PLUS_REQUIRED")
    expect(await plusRequired(me.id, null)).toBe(true)
    expect(await plusRequired(me.id, "  BENGALURU ")).toBe(true)
    expect(await plusRequired(me.id, "Mumbai")).toBe(false)
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

/** Today in India, as PLUS_GATING writes a flip date: gating went on at midnight IST today. */
const TODAY = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10)
const FLIPPED_TODAY = `Bengaluru:${TODAY}`

/** An account that was already here long before today's flip. */
async function oldHand(label = "plusold") {
  const p = await person(label)
  await db.user.update({ where: { id: p.id }, data: { createdAt: new Date(Date.now() - 200 * DAY) } })
  return p
}

describe("the trial: for people already out before their city flipped, once (MN-I08, review M4)", () => {
  it("gives an account that was out in the 90 days before the flip 14 days of Plus at its first refusal, audited, and never again", async () => {
    process.env.PLUS_GATING = FLIPPED_TODAY
    const v = await venue()
    const regular = await oldHand()
    await nightsOut(regular.id, 1, { daysAgo: 89 })
    const before = Date.now()
    expect((await goLive(regular.token, v, { stay: true })).status).toBe(200)
    const [trial] = await grants(regular.id)
    expect(trial).toMatchObject({ product: "plus", external_ref: trialRef(regular.id) })
    expect(trial.expires_at!.getTime() - trial.starts_at.getTime()).toBe(1_209_600_000)
    expect(trial.starts_at.getTime()).toBeGreaterThanOrEqual(before)
    expect(await audits(regular.id)).toEqual([
      { action: "entitlement.trial", user_id: null, details: expect.objectContaining({ ref: trialRef(regular.id), product: "plus" }) },
    ])

    // Over: no second one, however it is asked, or how many at once.
    await db.entitlements.update({ where: { id: trial.id }, data: { starts_at: new Date(Date.now() - 20 * DAY), expires_at: new Date(Date.now() - 6 * DAY) } })
    const answers = await Promise.all([plusRequired(regular.id, "Bengaluru"), plusRequired(regular.id, "Bengaluru")])
    expect(answers).toEqual([true, true])
    expect(await grants(regular.id)).toHaveLength(1)
  })

  it("lets two first refusals at once both see the one trial", async () => {
    process.env.PLUS_GATING = FLIPPED_TODAY
    const regular = await oldHand()
    await nightsOut(regular.id, 1)
    expect(await Promise.all([plusRequired(regular.id, "Bengaluru"), plusRequired(regular.id, "Bengaluru")])).toEqual([false, false])
    expect(await grants(regular.id)).toHaveLength(1)
  })

  it("gives none to an account made after the flip, to one only out after it or long before it, or where the flip has no date", async () => {
    process.env.PLUS_GATING = FLIPPED_TODAY
    const fresh = await person("plusnew")
    await nightsOut(fresh.id, 1)
    const lateComer = await oldHand()
    await nightsOut(lateComer.id, 1, { daysAgo: 0 })
    await db.event_check_ins.updateMany({ where: { user_id: lateComer.id }, data: { check_in_time: new Date() } })
    const longAgo = await oldHand()
    await nightsOut(longAgo.id, 1, { daysAgo: 95 })
    const never = await oldHand()
    for (const p of [fresh, lateComer, longAgo, never]) {
      expect(await plusRequired(p.id, "Bengaluru")).toBe(true)
      expect(await grants(p.id)).toHaveLength(0)
    }
    process.env.PLUS_GATING = "Bengaluru"
    const undated = await oldHand()
    await nightsOut(undated.id, 1)
    expect(await plusRequired(undated.id, "Bengaluru")).toBe(true)
    expect(await grants(undated.id)).toHaveLength(0)
  })

  it("is nothing in a launch-season city: no trial is used up where nothing is locked", async () => {
    process.env.PLUS_GATING = `Mumbai:${TODAY}`
    const regular = await oldHand()
    await nightsOut(regular.id, 1)
    expect(await plusRequired(regular.id, "Bengaluru")).toBe(false)
    expect(await grants(regular.id)).toHaveLength(0)
  })

  it("takes the grant back with a refused audit row: no Plus without its audit", async () => {
    process.env.PLUS_GATING = FLIPPED_TODAY
    const regular = await oldHand()
    await nightsOut(regular.id, 1)
    await refusingWrites("audit_logs", "INSERT", `NEW.resource_id = '${regular.id}'`, async () => {
      await expect(plusRequired(regular.id, "Bengaluru")).rejects.toThrow()
    })
    expect(await grants(regular.id)).toHaveLength(0)
    expect(await plusRequired(regular.id, "Bengaluru")).toBe(false)
    expect(await grants(regular.id)).toHaveLength(1)
  })
})

/** An event with `others` other people who came, `daysAgo` days ago. */
async function crowdedEvent(others = 5, daysAgo = 4) {
  if (hosts.length === 0) hosts.push(await makeUser(testId("plus_host"), "organizer"))
  const eventId = await makeEvent(hosts[0])
  extraEvents.push(eventId)
  for (let i = 0; i < others; i++) {
    const crowd = await makeUser(testId("plus_crowd"))
    world.users.push(crowd)
    await nightAt(crowd, eventId, daysAgo)
  }
  return eventId
}

async function nightAt(userId: string, eventId: string, daysAgo = 4) {
  const at = new Date(Date.now() - daysAgo * DAY)
  await db.event_check_ins.create({
    data: { event_id: eventId, occurrence_id: await occurrenceOf(eventId), user_id: userId, kind: "attendee", status: "checked_out", check_in_time: at, created_at: at },
  })
}

/** `n` new people who joined through the inviter's link ten days ago. */
async function invited(inviter: { id: string }, n: number) {
  const token = await inviteTokenFor(inviter.id)
  const friends = []
  for (let i = 0; i < n; i++) {
    const f = await person("plusfriend")
    expect((await friendRequests.POST(req("/api/mobile/friends/requests", f.token, "POST", { token }))).status).toBe(200)
    friends.push(f)
  }
  await db.referrals.updateMany({ where: { inviter_id: inviter.id }, data: { created_at: new Date(Date.now() - 10 * DAY) } })
  return friends
}

describe("the referral month: three new people, three real nights (MN-I09, review M4)", () => {
  it("pays one month once three invited people have each been to a different event with 5 others, 72 hours ago or more — once each", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const inviter = await person("plusinviter")
    const friends = await invited(inviter, 6)
    for (const f of friends.slice(0, 3)) await nightAt(f.id, await crowdedEvent())
    // One of them twice: still one person.
    await nightAt(friends[0].id, await crowdedEvent())

    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(false)
    const [month] = await grants(inviter.id)
    expect(month.external_ref).toMatch(/^plus-referral:/)
    const start = month.starts_at
    const oneMonthOn = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
    oneMonthOn.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(oneMonthOn.getUTCFullYear(), oneMonthOn.getUTCMonth() + 1, 0)).getUTCDate()))
    oneMonthOn.setUTCHours(start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds())
    expect(month.expires_at!.toISOString()).toBe(oneMonthOn.toISOString())
    expect(await audits(inviter.id)).toEqual([
      { action: "entitlement.referral", user_id: null, details: expect.objectContaining({ ref: month.external_ref, invitees: 3 }) },
    ])
    const rewarded = await db.referrals.findMany({ where: { inviter_id: inviter.id, rewarded_at: { not: null } }, select: { invitee_id: true, rewarded_ref: true } })
    expect(rewarded.map((r) => r.invitee_id).sort()).toEqual(friends.slice(0, 3).map((f) => f.id).sort())
    expect(new Set(rewarded.map((r) => r.rewarded_ref))).toEqual(new Set([month.external_ref]))

    // Over: the fourth alone pays nothing — the three already counted.
    await db.entitlements.update({ where: { id: month.id }, data: { expires_at: new Date(Date.now() - 1000), starts_at: new Date(Date.now() - 2000) } })
    await nightAt(friends[3].id, await crowdedEvent())
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(true)
    expect(await grants(inviter.id)).toHaveLength(1)
    // Three NEW people make a second month, for those three.
    for (const f of friends.slice(4)) await nightAt(f.id, await crowdedEvent())
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(false)
    const [, second] = await grants(inviter.id)
    expect(second.external_ref).not.toBe(month.external_ref)
    expect(await db.referrals.count({ where: { inviter_id: inviter.id, rewarded_ref: second.external_ref } })).toBe(3)
  })

  it.each([
    ["all three at the same event", "same"],
    ["an event with only 4 others there", "thin"],
    ["the third night under 72 hours ago", "fresh"],
    ["the inviter and their other invitees as the crowd", "own"],
    ["a friend suspended by the time it is paid", "suspended"],
    ["a friend who deleted their account", "deleted"],
  ])("pays nothing for %s", async (_label, kind) => {
    process.env.PLUS_GATING = "Bengaluru"
    const inviter = await person("plusinviter")
    const friends = await invited(inviter, kind === "own" ? 8 : 3)
    if (kind === "same") {
      const shared = await crowdedEvent()
      for (const f of friends) await nightAt(f.id, shared)
    } else if (kind === "own") {
      // Two real nights, and a third where the "crowd" is the inviter and five more of their invitees.
      for (const f of friends.slice(0, 2)) await nightAt(f.id, await crowdedEvent())
      const staged = await crowdedEvent(0)
      for (const f of [inviter, ...friends.slice(2)]) await nightAt(f.id, staged)
    } else {
      await nightAt(friends[0].id, await crowdedEvent())
      await nightAt(friends[1].id, await crowdedEvent())
      await nightAt(friends[2].id, await crowdedEvent(kind === "thin" ? 4 : 5), kind === "fresh" ? 2 : 4)
      if (kind === "suspended") await db.user.update({ where: { id: friends[2].id }, data: { suspended_at: new Date() } })
      if (kind === "deleted") await db.user.update({ where: { id: friends[2].id }, data: { deletedAt: new Date() } })
    }
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(true)
    expect(await grants(inviter.id)).toHaveLength(0)
  })

  it("pays at most 3 months a year", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    const inviter = await person("plusinviter")
    for (let i = 0; i < 3; i++) {
      await db.entitlements.create({
        data: {
          subject_kind: "user", subject_id: inviter.id, product: "plus", source: "grant",
          external_ref: `plus-referral:${inviter.id}:earlier${i}`,
          starts_at: new Date(Date.now() - (60 - i) * DAY), expires_at: new Date(Date.now() - (30 - i) * DAY),
        },
      })
    }
    const friends = await invited(inviter, 3)
    for (const f of friends) await nightAt(f.id, await crowdedEvent())
    expect(await plusRequired(inviter.id, "Bengaluru")).toBe(true)
    expect(await grants(inviter.id)).toHaveLength(3)
  })

  it("grants one thing when a trial and a banked month are both owed and three requests arrive at once (review M3)", async () => {
    process.env.PLUS_GATING = FLIPPED_TODAY
    const inviter = await oldHand("plusinviter")
    await nightsOut(inviter.id, 1)
    const friends = await invited(inviter, 3)
    for (const f of friends) await nightAt(f.id, await crowdedEvent())
    const answers = await Promise.all([1, 2, 3].map(() => plusRequired(inviter.id, "Bengaluru")))
    expect(answers).toEqual([false, false, false])
    const owed = await grants(inviter.id)
    expect(owed.map((g) => g.external_ref)).toEqual([trialRef(inviter.id)])
    expect(await hasPlus(inviter.id)).toBe(true)
  })

  it("finds three people with three different events only when they exist (Hall's condition)", () => {
    const sets = (o: Record<string, string[]>) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]))
    expect(threeOnDistinctEvents(sets({ a: ["e1", "e2", "e3"], b: ["e1"], c: ["e1"] }))).toBeNull()
    expect(threeOnDistinctEvents(sets({ a: ["e1", "e2"], b: ["e1", "e2"], c: ["e1", "e2"] }))).toBeNull()
    expect(threeOnDistinctEvents(sets({ a: ["e1"], b: ["e2"], c: ["e1", "e3"] }))).toEqual(["a", "b", "c"])
    expect(threeOnDistinctEvents(sets({ a: ["e1"], b: ["e1"], c: ["e2"], d: ["e3"] }))).toEqual(["a", "c", "d"])
  })

  it("counts only a new signup: somebody already on Blendn using a link is a friend request, not a referral", async () => {
    const inviter = await person()
    const regular = await person()
    await db.user.update({ where: { id: regular.id }, data: { createdAt: new Date(Date.now() - 8 * DAY) } })
    const res = await friendRequests.POST(req("/api/mobile/friends/requests", regular.token, "POST", { token: await inviteTokenFor(inviter.id) }))
    expect(res.status).toBe(200)
    expect(await db.referrals.count({ where: { invitee_id: regular.id } })).toBe(0)
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

describe("hasEntitlement answers for exactly what it is asked (no widening)", () => {
  it("a Night Pass is a Night Pass, not Plus; only lib/plus.ts counts it as Plus; a person's row never answers for an org or a venue", async () => {
    const me = await person()
    await plus(me.id, { product: "night_pass", until: Date.now() + 3_600_000 })
    expect(await hasEntitlement({ kind: "user", id: me.id }, "night_pass")).toBe(true)
    expect(await hasEntitlement({ kind: "user", id: me.id }, "plus")).toBe(false)
    expect(await hasPlus(me.id)).toBe(true)
    await plus(me.id)
    expect(await hasEntitlement({ kind: "org", id: me.id }, "analytics")).toBe(false)
    expect(await hasEntitlement({ kind: "org", id: me.id }, "plus")).toBe(false)
    expect(await hasEntitlement({ kind: "venue", id: me.id }, "venue_pro")).toBe(false)
    expect(await hasEntitlement({ kind: "user", id: me.id }, "analytics")).toBe(false)
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

describe("an admin gives or ends a person's Blendn+ (SCRUM-583, review M5)", () => {
  const as = (id: string, role: "app_admin" | "organizer") => mockGetAuth.mockResolvedValue({ user: { id, role } })

  it("grants it for whole months with the reason audited in the same transaction, one at a time, and ends only that grant", async () => {
    const admin = await makeUser(testId("plus_admin"), "app_admin")
    world.users.push(admin)
    const reviewer = await person("plusreviewer")
    await plus(reviewer.id, { until: Date.now() + 3 * DAY })
    as(admin, "app_admin")

    const { expiresAt } = await grantPlus(reviewer.id, 1, "App Review account for the iOS submission")
    const [row] = await db.entitlements.findMany({ where: { subject_id: reviewer.id, source: "grant" } })
    expect(row).toMatchObject({ product: "plus", external_ref: null })
    expect(row.expires_at!.toISOString()).toBe(expiresAt)
    expect(await audits(reviewer.id)).toEqual([
      { action: "entitlement.granted", user_id: admin, details: expect.objectContaining({ product: "plus", months: 1, reason: "App Review account for the iOS submission" }) },
    ])
    await expect(grantPlus(reviewer.id, 3, "A second grant beside the first")).rejects.toThrow(/already has a grant/)
    expect(await personPlus(reviewer.id)).toEqual({
      grant: { expiresAt },
      held: expect.objectContaining({ product: "plus" }),
    })

    await endPlusGrant(reviewer.id, "Review finished, no longer needed")
    expect(await hasEntitlement({ kind: "user", id: reviewer.id }, "plus")).toBe(true) // the store's row is untouched
    expect((await db.entitlements.findUniqueOrThrow({ where: { id: row.id } })).expires_at!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it("never ends a trial or a referral month, and refuses non-admins, short reasons and deleted accounts — writing nothing", async () => {
    const admin = await makeUser(testId("plus_admin"), "app_admin")
    const organiser = await makeUser(testId("plus_org"), "organizer")
    world.users.push(admin, organiser)
    const trialist = await person()
    await db.entitlements.create({
      data: { subject_kind: "user", subject_id: trialist.id, product: "plus", source: "grant", external_ref: trialRef(trialist.id), starts_at: new Date(Date.now() - DAY), expires_at: new Date(Date.now() + 13 * DAY) },
    })
    as(admin, "app_admin")
    await expect(endPlusGrant(trialist.id, "Ending what is not ours to end")).rejects.toThrow(/already ended/)
    expect(await hasPlus(trialist.id)).toBe(true)

    const target = await person()
    as(organiser, "organizer")
    await expect(grantPlus(target.id, 1, "An organiser trying this")).rejects.toThrow(/Forbidden/)
    as(admin, "app_admin")
    await expect(grantPlus(target.id, 1, "short")).rejects.toThrow(/10 to 500/)
    await db.user.update({ where: { id: target.id }, data: { deletedAt: new Date() } })
    await expect(grantPlus(target.id, 1, "A deleted account cannot hold Plus")).rejects.toThrow(/not found/)
    expect(await grants(target.id)).toHaveLength(0)
  })
})

describe("GET /me/plus is rate limited (review L9)", () => {
  it("answers 429 once a person polls it past 60 a minute", async () => {
    const me = await person()
    let first429 = 0
    for (let i = 1; i <= 70 && !first429; i++) {
      const res = await plusRoute.GET(req("/api/mobile/me/plus", me.token))
      if (res.status === 429) first429 = i
    }
    expect(first429).toBe(61)
  })
})

