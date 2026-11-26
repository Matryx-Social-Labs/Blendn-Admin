process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

let mockSession: { user: { id: string; role: string; email: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(mockSession) }))

import * as store from "@/lib/rate-limit-store"
import { entryCode } from "@/lib/entry-code"
import { codeStep } from "@/lib/rotating-code"
import { pauseEntryCode, readDoor, resumeEntryCode } from "@/app/dashboard/events/[id]/door/actions"

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, eventParams, FENCE, LAT, LNG, person, req, routes, until, world } from "./go-live-world"

/**
 * The door code at the event door (gate 13, SCRUM-1316; design/02a SPEC §2,
 * §3, §5), through the real route and a db:migrate database: every way a code
 * is refused, recorded and counted, the GPS path unchanged, and the host's
 * Door read gated on `canOperate`.
 */

const HOUR = 3_600_000
const MIN = 60_000
/** About 400 m north of the fence's centre: 340 m from its edge, so a shortfall of ~290 m with a 30 m fix. */
const NEAR = { latitude: LAT + 400 / 111_320, longitude: LNG }
/** About 2.2 km north: a shortfall well over 1 km. */
const FAR = { latitude: LAT + 0.02, longitude: LNG }
const INSIDE = { latitude: LAT, longitude: LNG }
const fix = (where: { latitude: number; longitude: number }, gpsAccuracy?: number, extra: object = {}) => ({
  ...where,
  ...(gpsAccuracy !== undefined && { deviceInfo: { gpsAccuracy, ...extra } }),
})

const orgs: string[] = []
afterAll(async () => {
  const ids = (await db.events.findMany({ where: { slug: { startsWith: "itest_entry" } }, select: { id: true } })).map((e) => e.id)
  await db.audit_logs.deleteMany({ where: { resource_id: { in: ids } } })
  await db.check_in_refusals.deleteMany({ where: { event_id: { in: ids } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: ids } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: ids } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: ids } } })
  await db.event_match_preferences.deleteMany({ where: { event_id: { in: ids } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: ids } } })
  await db.events.deleteMany({ where: { id: { in: ids } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanupWorld()
  await closeDb()
}, 60_000)

beforeEach(() => store.resetMemoryStore())
afterEach(() => {
  jest.restoreAllMocks()
  mockSession = null
})

/** Codes from two or three steps back are computed before the request: never in the last 5 s of a step, or the step turns mid-test. */
async function midStep() {
  const into = Date.now() % 30_000
  if (into > 25_000) await new Promise((r) => setTimeout(r, 30_000 - into + 200))
}

/** A live published event at the fixture fence, run by a new organisation; its days from `days` (hours from now). */
async function event(opts: { days?: ReadonlyArray<{ startsIn: number; endsIn: number }>; reviewDemo?: boolean } = {}) {
  const org = await db.organisations.create({ data: { display_name: testId("Entry Org"), kind: "company", status: "verified" } })
  orgs.push(org.id)
  const host = await makeUser(testId("entry_host"), "organizer")
  world.users.push(host)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner" } })
  const days = opts.days ?? [{ startsIn: -1, endsIn: 2 }]
  const row = await db.events.create({
    data: {
      slug: testId("entry"),
      title: "Entry code fixture",
      description: "integration fixture",
      start_time: new Date(Date.now() + days[0].startsIn * HOUR),
      end_time: new Date(Date.now() + days[days.length - 1].endsIn * HOUR),
      timezone: "Asia/Kolkata",
      status: "published",
      visibility: "public",
      organizer_id: host,
      organizer_org_id: org.id,
      review_demo: opts.reviewDemo ?? false,
      latitude: LAT,
      longitude: LNG,
      geofence: FENCE,
    },
  })
  const occurrences: string[] = []
  for (const [i, d] of days.entries()) {
    const o = await db.event_occurrences.create({
      data: {
        event_id: row.id,
        occurs_on: new Date(Date.UTC(2030, 0, 1 + i)),
        start_time: new Date(Date.now() + d.startsIn * HOUR),
        end_time: new Date(Date.now() + d.endsIn * HOUR),
      },
    })
    occurrences.push(o.id)
  }
  return { id: row.id, occurrence: occurrences[occurrences.length - 1], occurrences, host, org: org.id }
}

const code = (e: { id: string; occurrence: string }, back = 0) => entryCode(e.id, e.occurrence, codeStep(new Date()) - back)
const wrongFor = (e: { id: string; occurrence: string }) => {
  const valid = new Set([0, 1, 2, 3].map((b) => code(e, b)))
  return ["ABCDEF", "GHJKLM", "NPQRTU", "VWXY34"].find((c) => !valid.has(c))!
}

const checkIn = (token: string, eventId: string, body: object) =>
  routes.checkin.POST(req(`/api/mobile/events/${eventId}/checkin`, token, "POST", body), eventParams(eventId))

const refusals = (eventId: string, userId: string, n = 1) =>
  until(
    () => db.check_in_refusals.findMany({ where: { event_id: eventId, user_id: userId }, orderBy: { created_at: "asc" }, select: { reason: true, accuracy_metres: true } }),
    (rows) => rows.length >= n,
    1_500
  )

const checkInRow = (eventId: string, userId: string) =>
  db.event_check_ins.findFirst({ where: { event_id: eventId, user_id: userId }, select: { method: true, status: true } })

describe("a door code at the check-in door", () => {
  it("admits from 400 m with a valid code and records method door_code", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(res.status).toBe(200)
    expect(await checkInRow(e.id, p.id)).toEqual({ method: "door_code", status: "checked_in" })
  })

  it("admits the code from two steps back, lower case and spaced", async () => {
    const e = await event()
    const p = await person("entry")
    await midStep()
    const c = code(e, 2)
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: ` ${c.slice(0, 3).toLowerCase()} ${c.slice(3)}` })
    expect(res.status).toBe(200)
  })

  it("refuses a wrong code and records door_code_wrong", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      errorCode: "DOOR_CODE_WRONG",
      error: "That code didn’t match. Check the host’s screen; it may have just changed.",
    })
    expect((await refusals(e.id, p.id)).map((r) => r.reason)).toEqual(["door_code_wrong"])
    expect(await checkInRow(e.id, p.id)).toBeNull()
  })

  it("answers 'just changed' to step −3 and counts no guess", async () => {
    const e = await event()
    const p = await person("entry")
    await midStep()
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e, 3) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ errorCode: "DOOR_CODE_CHANGED", error: "That code just changed. Read the new one on the host’s screen." })
    expect(await store.peek(`entry-fail:${e.occurrence}:${p.id}`)).toBe(0)
    expect(await store.peek(`entry-wrong:${e.occurrence}`)).toBe(0)
  })

  it("refuses another occurrence's code", async () => {
    const e = await event({ days: [{ startsIn: -26, endsIn: -22 }, { startsIn: -1, endsIn: 2 }] })
    const p = await person("entry")
    const yesterdays = entryCode(e.id, e.occurrences[0], codeStep(new Date()))
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: yesterdays })
    expect((await res.json()).errorCode).toBe("DOOR_CODE_WRONG")
  })

  it.each([
    ["more than 1 km short", fix(FAR, 30)],
    ["no accuracy", fix(NEAR)],
    ["accuracy over 1000 m", fix(NEAR, 1200)],
    ["a mocked fix", fix(NEAR, 30, { mocked: true })],
  ])("refuses a valid code with %s as door_code_far", async (_label, body) => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, { ...body, doorCode: code(e) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ errorCode: "DOOR_CODE_FAR", error: "You need to be at the venue to use the door code." })
    expect((await refusals(e.id, p.id)).map((r) => r.reason)).toEqual(["door_code_far"])
  })

  it("answers far before comparing: a wrong code from 2 km is far, and counts nothing", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, { ...fix(FAR, 30), doorCode: wrongFor(e) })
    expect((await res.json()).errorCode).toBe("DOOR_CODE_FAR")
    expect(await store.peek(`entry-fail:${e.occurrence}:${p.id}`)).toBe(0)
    expect(await store.peek(`entry-wrong:${e.occurrence}`)).toBe(0)
  })

  it("never locks someone for trying from too far: five far tries, then the code at the door works", async () => {
    const e = await event()
    const p = await person("entry")
    for (let i = 0; i < 5; i++) expect((await (await checkIn(p.token, e.id, { ...fix(FAR, 30), doorCode: code(e) })).json()).errorCode).toBe("DOOR_CODE_FAR")
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
  })

  it("counts a right code once per person, so resubmitting it cannot hold off a pause", async () => {
    const e = await event()
    const p = await person("entry")
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
    expect(await store.peek(`entry-right:${e.occurrence}`)).toBe(1)
  })

  it("locks a person after 5 wrong codes in 10 minutes: 429 with the time on the event's clock", async () => {
    const e = await event()
    const p = await person("entry")
    for (let i = 0; i < 5; i++) expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })).status).toBe(400)
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(res.status).toBe(429)
    const json = await res.json()
    expect(json.errorCode).toBe("DOOR_CODE_LOCKED")
    expect(json.error).toMatch(/^Too many tries\. Try again at \d{1,2}:\d{2} (AM|PM), or step outside and use GPS\.$/)
    expect((await refusals(e.id, p.id, 6)).map((r) => r.reason).at(-1)).toBe("door_code_locked")
    // GPS still works.
    expect((await checkIn(p.token, e.id, fix(INSIDE, 10))).status).toBe(200)
  })

  it("lets no more than 5 of a parallel burst reach the compare", async () => {
    const e = await event()
    const p = await person("entry")
    const answers = await Promise.all(Array.from({ length: 12 }, () => checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })))
    const codes = await Promise.all(answers.map(async (r) => (await r.json()).errorCode))
    expect(codes.filter((c) => c === "DOOR_CODE_WRONG")).toHaveLength(5)
    expect(codes.filter((c) => c === "DOOR_CODE_LOCKED")).toHaveLength(7)
  })

  it("turns code entry off for the night after 10 wrong in the occurrence", async () => {
    const e = await event()
    const p = await person("entry")
    for (let i = 0; i < 10; i++) await store.hit(`entry-night:${e.occurrence}:${p.id}`, HOUR)
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(res.status).toBe(429)
    expect((await res.json()).errorCode).toBe("DOOR_CODE_LOCKED")
  })

  it("refuses while paused, but not on a pause from before this occurrence's doors, nor after it lifts", async () => {
    const e = await event()
    const p = await person("entry")
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date(Date.now() - 2 * MIN) } })
    const paused = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(paused.status).toBe(400)
    expect(await paused.json()).toMatchObject({ errorCode: "DOOR_CODE_PAUSED", error: "The door code is paused. Ask the host." })
    expect((await refusals(e.id, p.id)).map((r) => r.reason)).toEqual(["door_code_paused"])

    // Doors were 2.5 h ago (start −1 h, doors −90 min): a pause three hours back is another night's.
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date(Date.now() - 3 * HOUR) } })
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
  })

  it("lifts the pause after ten minutes", async () => {
    const e = await event()
    const p = await person("entry")
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date(Date.now() - 11 * MIN) } })
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
  })

  it("auto-pauses when wrong ≥ 30 and wrong > correct, audited as the system", async () => {
    const e = await event()
    for (let i = 0; i < 29; i++) await store.hit(`entry-wrong:${e.occurrence}`, 10 * MIN)
    const p = await person("entry")
    await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })
    const row = await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })
    expect(row.door_code_paused_at).not.toBeNull()
    const audit = await until(
      () => db.audit_logs.findMany({ where: { resource_id: e.id, action: "event.door_code_paused" }, select: { user_id: true, details: true } }),
      (rows) => rows.length > 0,
      1_500
    )
    expect(audit[0].user_id).toBeNull()
  })

  it("auto-pauses over another night's pause still on the row", async () => {
    const e = await event()
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date(Date.now() - 3 * HOUR) } })
    for (let i = 0; i < 29; i++) await store.hit(`entry-wrong:${e.occurrence}`, 10 * MIN)
    const p = await person("entry")
    await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })
    const row = await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })
    expect(Date.now() - row.door_code_paused_at!.getTime()).toBeLessThan(MIN)
  })

  it("does not auto-pause a busy honest door (wrong ≤ correct)", async () => {
    const e = await event()
    for (let i = 0; i < 40; i++) await store.hit(`entry-right:${e.occurrence}`, 10 * MIN)
    for (let i = 0; i < 35; i++) await store.hit(`entry-wrong:${e.occurrence}`, 10 * MIN)
    const p = await person("entry")
    await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: wrongFor(e) })
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).toBeNull()
  })

  it("counts a bad-shape code against the person only", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: "0O1I" })
    expect((await res.json()).errorCode).toBe("DOOR_CODE_WRONG")
    expect(await store.peek(`entry-fail:${e.occurrence}:${p.id}`)).toBe(1)
    expect(await store.peek(`entry-wrong:${e.occurrence}`)).toBe(0)
  })

  it("refuses the code path when the counters cannot be read, and leaves GPS alone", async () => {
    const e = await event()
    const p = await person("entry")
    // Redis down as a fail-closed key sees it; the route's own fail-open `safety` limiter counts in memory as it would.
    const { hit, peek } = store
    const down = <A extends unknown[], R>(real: (key: string, ...rest: A) => Promise<R>) =>
      (key: string, ...rest: A) => (key.startsWith("entry-") ? Promise.reject(new store.StoreUnavailable("down")) : real(key, ...rest))
    jest.spyOn(store, "peek").mockImplementation(down(peek))
    jest.spyOn(store, "hit").mockImplementation(down(hit))
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ errorCode: "DOOR_CODE_UNAVAILABLE", error: "The door code isn’t available right now. Try GPS." })
    // SPEC §3's refusal reasons have none for an outage: nothing is recorded, by design.
    await new Promise((r) => setTimeout(r, 300))
    expect(await db.check_in_refusals.count({ where: { event_id: e.id, user_id: p.id } })).toBe(0)
    jest.restoreAllMocks()
    expect((await checkIn(p.token, e.id, fix(INSIDE, 10))).status).toBe(200)
  })

  it("lets a review account through a review_demo event first, ignoring the code, as method review", async () => {
    const e = await event({ reviewDemo: true })
    const reviewer = await person("entry")
    const before = process.env.REVIEW_ACCOUNT_IDS
    process.env.REVIEW_ACCOUNT_IDS = reviewer.id
    try {
      const res = await checkIn(reviewer.token, e.id, { ...fix(FAR, 30), doorCode: "NOTACODE" })
      expect(res.status).toBe(200)
      expect(await checkInRow(e.id, reviewer.id)).toEqual({ method: "review", status: "checked_in" })
      expect(await store.peek(`entry-fail:${e.occurrence}:${reviewer.id}`)).toBe(0)
    } finally {
      if (before === undefined) delete process.env.REVIEW_ACCOUNT_IDS
      else process.env.REVIEW_ACCOUNT_IDS = before
    }
  })

  it("turns code entry off for a person the host removed from the room", async () => {
    const e = await event()
    const p = await person("entry")
    expect((await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
    await db.chat_group_members.updateMany({ where: { user_id: p.id, chat_group: { event_id: e.id } }, data: { status: "banned", banned_by: e.host } })
    await db.event_check_ins.updateMany({ where: { event_id: e.id, user_id: p.id }, data: { status: "checked_out", check_out_time: new Date() } })
    const res = await checkIn(p.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })
    expect(res.status).toBe(429)
    expect((await res.json()).errorCode).toBe("DOOR_CODE_LOCKED")
  })
})

describe("the GPS door, unchanged apart from recording a weak fix", () => {
  it("answers a no-code check-in in exactly the shape it always did, method gps", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, fix(INSIDE, 10))
    expect(res.status).toBe(200)
    const json = await res.json()
    const row = await db.event_check_ins.findFirstOrThrow({ where: { event_id: e.id, user_id: p.id } })
    expect(json).toEqual({
      success: true,
      data: {
        checkIn: { id: row.id, status: "checked_in", checkInTime: row.check_in_time!.toISOString(), eventId: e.id },
        revealSuggestion: false,
        intentNeeded: true,
        left: [],
        message: "Successfully checked in",
      },
    })
    expect(row.method).toBe("gps")
  })

  it("records a vague fix as weak_fix with its accuracy, and offers the code", async () => {
    const e = await event()
    const p = await person("entry")
    const res = await checkIn(p.token, e.id, fix(INSIDE, 400))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      errorCode: "OUT_OF_RANGE",
      reasonCode: "DOOR_CODE_OFFERED",
      error: "GPS signal is too weak (accuracy: 400m). Move to an area with better signal and try again.",
    })
    expect(await refusals(e.id, p.id)).toEqual([{ reason: "weak_fix", accuracy_metres: 400 }])
  })

  it("offers the code on an out-of-range refusal within 1 km, and not beyond, nor while paused", async () => {
    const e = await event()
    const p = await person("entry")
    expect((await (await checkIn(p.token, e.id, fix(NEAR, 30))).json()).reasonCode).toBe("DOOR_CODE_OFFERED")
    const far = await (await checkIn(p.token, e.id, fix(FAR, 30))).json()
    expect(far.errorCode).toBe("OUT_OF_RANGE")
    expect(far).not.toHaveProperty("reasonCode")
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date() } })
    expect(await (await checkIn(p.token, e.id, fix(NEAR, 30))).json()).not.toHaveProperty("reasonCode")
  })

  it("tells the app whether the door code is available, never the code", async () => {
    const e = await event()
    const p = await person("entry")
    const read = async () => (await (await routes.event.GET(req(`/api/mobile/events/${e.id}`, p.token), eventParams(e.id))).json()).data
    const data = await read()
    expect(data.doorCode).toEqual({ available: true })
    expect(JSON.stringify(data)).not.toContain(code(e))
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date() } })
    expect((await read()).doorCode).toEqual({ available: false })
  })
})

describe("the host's Door", () => {
  const signIn = (id: string, role = "organizer") => {
    mockSession = { user: { id, role, email: `${id}@itest.invalid` } }
  }

  it("reads the code, counts and pseudonyms for a member of the organisation, never an identity", async () => {
    const e = await event()
    const colleague = await makeUser(testId("entry_colleague"), "organizer")
    world.users.push(colleague)
    await db.organisation_members.create({ data: { org_id: e.org, user_id: colleague, role: "staff" } })
    const guest = await person("entry")
    expect((await checkIn(guest.token, e.id, { ...fix(NEAR, 30), doorCode: code(e) })).status).toBe(200)
    const gps = await person("entry")
    expect((await checkIn(gps.token, e.id, fix(INSIDE, 10))).status).toBe(200)

    signIn(colleague)
    const view = await readDoor(e.id, true)
    if (view.kind !== "open") throw new Error(`expected open, got ${view.kind}`)
    expect(view.code?.value).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(view.byCode).toBe(1)
    expect(view.byGps).toBe(1)
    expect(view.arrivals).toHaveLength(1)
    expect(Object.keys(view.arrivals[0]).sort()).toEqual(["at", "pseudonym", "ref"])
    const member = await db.chat_group_members.findFirstOrThrow({ where: { user_id: guest.id, chat_group: { event_id: e.id } } })
    expect(view.arrivals[0].pseudonym).toBe(member.anonymous_name)
    const text = JSON.stringify(view)
    const account = await db.user.findUniqueOrThrow({ where: { id: guest.id }, select: { name: true, email: true } })
    for (const leak of [guest.id, account.email, account.name!]) expect(text).not.toContain(leak)

    // The tab asks without the code.
    const tab = await readDoor(e.id, false)
    expect(tab.kind === "open" && tab.code).toBeNull()
  })

  it("refuses the code and the pause to someone outside the organisation", async () => {
    const e = await event()
    const stranger = await makeUser(testId("entry_stranger"), "organizer")
    world.users.push(stranger)
    signIn(stranger)
    expect(await readDoor(e.id, true)).toEqual({ kind: "not_authorized" })
    expect(await pauseEntryCode(e.id)).toEqual({ kind: "not_authorized" })
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).toBeNull()

    // Nor resume someone else's pause, nor reset its counters.
    const pausedAt = new Date()
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: pausedAt } })
    await store.hit(`entry-wrong:${e.occurrence}`, 10 * MIN)
    expect(await resumeEntryCode(e.id)).toEqual({ kind: "not_authorized" })
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).toEqual(pausedAt)
    expect(await store.peek(`entry-wrong:${e.occurrence}`)).toBe(1)
    expect(await readDoor("not-a-uuid", true)).toEqual({ kind: "not_authorized" })
  })

  it("says the code is unavailable, and shows none, when the counters cannot be read; a resume then fails rather than half-resetting", async () => {
    const e = await event()
    await db.events.update({ where: { id: e.id }, data: { door_code_paused_at: new Date() } })
    signIn(e.host)
    const down = () => Promise.reject(new store.StoreUnavailable("down"))
    jest.spyOn(store, "peek").mockImplementation(down)
    jest.spyOn(store, "forget").mockImplementation(down)
    const view = await readDoor(e.id, true)
    expect(view.kind === "open" && view.unavailable).toBe(true)
    expect(view.kind === "open" && view.code).toBeNull()
    await expect(resumeEntryCode(e.id)).rejects.toBeInstanceOf(store.StoreUnavailable)
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).not.toBeNull()
  })

  it("pauses and resumes by hand, audited, and a resume resets the event's counter", async () => {
    const e = await event()
    signIn(e.host)
    expect((await pauseEntryCode(e.id)).kind).toBe("open")
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).not.toBeNull()
    const paused = await readDoor(e.id, true)
    expect(paused.kind === "open" && paused.paused).toBeTruthy()
    expect(paused.kind === "open" && paused.code).toBeNull()

    await store.hit(`entry-wrong:${e.occurrence}`, 10 * MIN)
    expect((await resumeEntryCode(e.id)).kind).toBe("open")
    expect((await db.events.findUniqueOrThrow({ where: { id: e.id }, select: { door_code_paused_at: true } })).door_code_paused_at).toBeNull()
    expect(await store.peek(`entry-wrong:${e.occurrence}`)).toBe(0)
    const actions = await until(
      () => db.audit_logs.findMany({ where: { resource_id: e.id }, select: { action: true, user_id: true } }),
      (rows) => rows.length >= 2,
      1_500
    )
    expect(actions.map((a) => a.action).sort()).toEqual(["event.door_code_paused", "event.door_code_resumed"])
    expect(actions.every((a) => a.user_id === e.host)).toBe(true)
  })
})
