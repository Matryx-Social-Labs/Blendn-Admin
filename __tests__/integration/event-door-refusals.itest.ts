process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, eventParams, FENCE, INSIDE, LAT, LNG, person, req, routes, until, world } from "./go-live-world"

/**
 * The event door, every way it says no, through the route (step 4 review).
 *
 * The check-in route's rules moved into `lib/check-in-core.ts` to be shared
 * with Go Live; the unit guards read the source, and `checkin.itest.ts` drives
 * the happy path and the fence. This drives the rest — each refusal's status,
 * code and recorded reason — so the move can be checked against behaviour, not
 * only against shape.
 */

afterAll(async () => {
  const ids = (await db.events.findMany({ where: { slug: { startsWith: "itest_door" } }, select: { id: true } })).map((e) => e.id)
  await db.check_in_refusals.deleteMany({ where: { event_id: { in: ids } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: ids } } })
  await db.chat_group_members.deleteMany({ where: { chat_group: { event_id: { in: ids } } } })
  await db.chat_groups.deleteMany({ where: { event_id: { in: ids } } })
  await db.event_match_preferences.deleteMany({ where: { event_id: { in: ids } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: ids } } })
  await db.events.deleteMany({ where: { id: { in: ids } } })
  await cleanupWorld()
  await closeDb()
}, 60_000)

const HOUR = 3_600_000

/** An event; its one day from `startsIn` to `endsIn` hours from now. */
async function event(opts: {
  startsIn?: number
  endsIn?: number
  status?: "published" | "draft"
  fenced?: boolean
  minAge?: number
  days?: ReadonlyArray<{ startsIn: number; endsIn: number; cancelled?: boolean }>
}) {
  const host = await makeUser(testId("door_host"), "organizer")
  world.users.push(host)
  const days = opts.days ?? [{ startsIn: opts.startsIn ?? -1, endsIn: opts.endsIn ?? 2 }]
  const first = new Date(Date.now() + days[0].startsIn * HOUR)
  const last = new Date(Date.now() + days[days.length - 1].endsIn * HOUR)
  const fenced = opts.fenced ?? true
  const row = await db.events.create({
    data: {
      slug: testId("door"),
      title: "Door fixture",
      description: "integration fixture",
      start_time: first,
      end_time: last,
      timezone: "UTC",
      status: opts.status ?? "published",
      visibility: "public",
      organizer_id: host,
      min_age: opts.minAge ?? null,
      ...(fenced && { latitude: LAT, longitude: LNG, geofence: FENCE }),
    },
  })
  for (const [i, d] of days.entries()) {
    await db.event_occurrences.create({
      data: {
        event_id: row.id,
        occurs_on: new Date(Date.UTC(2030, 0, 1 + i)),
        start_time: new Date(Date.now() + d.startsIn * HOUR),
        end_time: new Date(Date.now() + d.endsIn * HOUR),
        ...(d.cancelled && { cancelled_at: new Date() }),
      },
    })
  }
  return row.id
}

const checkIn = (token: string, eventId: string, body: object = INSIDE) =>
  routes.checkin.POST(req(`/api/mobile/events/${eventId}/checkin`, token, "POST", body), eventParams(eventId))

const refusals = (eventId: string, userId: string) =>
  until(
    () => db.check_in_refusals.findMany({ where: { event_id: eventId, user_id: userId }, select: { reason: true } }),
    (rows) => rows.length > 0,
    1_500
  ).then((rows) => rows.map((r) => r.reason))

describe("the event door refuses, and records why", () => {
  it.each([
    ["a fix too vague to mean anything", {}, { ...INSIDE, deviceInfo: { gpsAccuracy: 400 } }, 400, "OUT_OF_RANGE", null],
    ["an event with no area and no pin", { fenced: false }, INSIDE, 400, "OUT_OF_RANGE", "no_geofence"],
    ["before doors", { startsIn: 3, endsIn: 6 }, INSIDE, 400, "EVENT_NOT_STARTED", "too_early"],
    ["after the window", { startsIn: -8, endsIn: -5 }, INSIDE, 400, "EVENT_ENDED", "too_late"],
    ["today's day called off", { days: [{ startsIn: -1, endsIn: 2, cancelled: true }] }, INSIDE, 400, null, "day_cancelled"],
    ["an unpublished event", { status: "draft" as const }, INSIDE, 400, null, null],
    ["an event too old for them", { minAge: 21 }, INSIDE, 403, "AGE_RESTRICTED", "under_age"],
  ] as const)("%s", async (_label, spec, body, status, code, reason) => {
    const eventId = await event(spec)
    const p = await person("door", { age: 19 })
    const res = await checkIn(p.token, eventId, body)
    expect(res.status).toBe(status)
    const json = await res.json()
    if (code) expect(json.errorCode).toBe(code)
    if (reason) expect(await refusals(eventId, p.id)).toEqual([reason])
    expect(await db.event_check_ins.count({ where: { event_id: eventId, user_id: p.id } })).toBe(0)
  })
})

describe("the event door lets in", () => {
  it("answers in the shape it always did, with the reveal suggestion", async () => {
    const eventId = await event({})
    const p = await person("door")
    await db.profiles.update({ where: { id: p.id }, data: { reveal_by_default: true } })
    const res = await checkIn(p.token, eventId)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(Object.keys(data).sort()).toEqual(["checkIn", "intentNeeded", "message", "revealSuggestion"])
    expect(Object.keys(data.checkIn).sort()).toEqual(["checkInTime", "eventId", "id", "status"])
    expect(data.revealSuggestion).toBe(true)
    expect(data.intentNeeded).toBe(true)
  })

  it("checks a multi-day event's guest in to today's day, not the first", async () => {
    const eventId = await event({ days: [{ startsIn: -26, endsIn: -22 }, { startsIn: -1, endsIn: 3 }] })
    const today = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId }, orderBy: { start_time: "desc" } })
    const p = await person("door")
    expect((await checkIn(p.token, eventId)).status).toBe(200)
    expect((await db.event_check_ins.findFirstOrThrow({ where: { event_id: eventId, user_id: p.id } })).occurrence_id).toBe(today.id)
  })
})
