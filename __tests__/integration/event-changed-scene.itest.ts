/**
 * The Scene's server gaps (Flow 3): "changed while you're going", the days of a
 * run, the link-refusal reasons, and the people who are going being told with
 * their own kind. Real handlers, real rows.
 *
 * The old fields are asserted untouched beside the new ones: installed apps read
 * the shape that was there.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
type Msg = { to: string; channelId?: string; data: { type: string; changed?: string } }
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
import { updateEventTracked } from "@/lib/event-change"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
import { eventParams, req, routes, yearsAgo } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dashboardEvent = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
const rsvpRoute = routes.rsvp

const HOUR = 3_600_000
const users: string[] = []
const orgs: string[] = []
const events: string[] = []
let host = ""
let admin = ""

const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, opts: { age?: number | null; onboarded?: boolean } = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (opts.onboarded !== false) await onboard(id)
  else await db.profiles.upsert({ where: { id }, create: { id, name: "Test", onboarded: false }, update: {} })
  const age = opts.age === undefined ? 30 : opts.age
  await db.profiles.update({ where: { id }, data: { date_of_birth: age === null ? null : yearsAgo(age), age: null } })
  return id
}

async function event(opts: {
  status?: "published" | "draft" | "cancelled"
  minAge?: number
  preSuspension?: "published"
  visibility?: "public" | "private"
  days?: Array<{ startsInH: number; endsInH: number; cancelled?: boolean }>
  orgId?: string
} = {}) {
  const days = opts.days ?? [{ startsInH: 48, endsInH: 51 }]
  const first = new Date(Date.now() + days[0].startsInH * HOUR)
  const last = new Date(Date.now() + days[days.length - 1].endsInH * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId("scn"),
      title: "Scene fixture",
      description: "integration fixture",
      start_time: first,
      end_time: last,
      timezone: "UTC",
      status: opts.status ?? "published",
      visibility: opts.visibility ?? "public",
      organizer_id: host,
      organizer_org_id: opts.orgId ?? orgs[0],
      venue_name: "The Old Room",
      address: "1 Church St",
      latitude: 12.97,
      longitude: 77.59,
      min_age: opts.minAge ?? null,
      pre_suspension_status: opts.preSuspension ?? null,
    },
  })
  events.push(row.id)
  for (const [i, d] of days.entries()) {
    await db.event_occurrences.create({
      data: {
        event_id: row.id,
        occurs_on: new Date(Date.UTC(2031, 0, 1 + i)),
        start_time: new Date(Date.now() + d.startsInH * HOUR),
        end_time: new Date(Date.now() + d.endsInH * HOUR),
        ...(d.cancelled && { cancelled_at: new Date() }),
      },
    })
  }
  return row.id
}

async function read(viewer: string, eventId: string) {
  const res = await routes.event.GET(req(`/api/mobile/events/${eventId}`, tokenOf(viewer)), eventParams(eventId))
  return { status: res.status, json: await res.json() }
}

async function dashboardPatch(id: string, body: Record<string, unknown>) {
  const res = await dashboardEvent.PATCH(
    new Request(`http://localhost/api/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  )
  expect(res.status).toBe(200)
}

async function going(eventId: string, label: string, status: "going" | "maybe" | "waitlisted" = "going", channelSet: number | null = null) {
  const id = await person(label)
  await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status } })
  await db.push_tokens.create({
    data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "android", ...(channelSet !== null && { channel_set: channelSet }) },
  })
  return id
}

beforeAll(async () => {
  host = await makeUser(testId("scn-host"), "organizer")
  admin = await makeUser(testId("scn-admin"), "app_admin")
  users.push(host, admin)
  await onboard(host, admin)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("scn-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

beforeEach(() => {
  sentMessages.length = 0
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: events } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
}, 60_000)

describe("GET /events/:id — what changed", () => {
  it("an event that has not changed says so, and every old field is where it was", async () => {
    const viewer = await person("scn-v1")
    const id = await event()
    const { status, json } = await read(viewer, id)

    expect(status).toBe(200)
    expect(json.data).toMatchObject({
      changedAt: null,
      changedFields: [],
      changedFrom: null,
      dayCount: 1,
      dayNumber: 1,
    })
    expect(json.data.days).toHaveLength(1)
    expect(json.data.days[0]).toMatchObject({ cancelled: false, date: "2031-01-01" })
    // The shape that was there.
    for (const key of ["id", "title", "startTime", "endTime", "session", "status", "venueName", "address", "stats", "userStatus", "organizer", "amenities"]) {
      expect(json.data).toHaveProperty(key)
    }
    expect(json.data.venueName).toBe("The Old Room")
  })

  it("a time and a venue moved through the dashboard: when, which, and what they were, and the going are told with event_changed", async () => {
    const viewer = await person("scn-v2")
    const id = await event()
    const goer = await going(id, "scn-going", "going", 2)
    const legacyGoer = await going(id, "scn-legacy", "going")
    const maybe = await going(id, "scn-maybe", "maybe", 2)
    const before = await db.events.findUniqueOrThrow({ where: { id } })

    const moved = new Date(before.start_time.getTime() + 2 * HOUR)
    await dashboardPatch(id, {
      start_time: moved.toISOString(),
      end_time: new Date(before.end_time.getTime() + 2 * HOUR).toISOString(),
      venue_name: "The New Room",
    })

    const { json } = await read(viewer, id)
    expect(new Date(json.data.changedAt).getTime()).toBeGreaterThan(Date.now() - 60_000)
    expect(json.data.changedFields).toEqual(["time", "venue"])
    expect(json.data.changedFrom).toEqual({
      startTime: before.start_time.toISOString(),
      endTime: before.end_time.toISOString(),
      venueName: "The Old Room",
    })
    // The live values are the new ones, in the fields that were always there.
    expect(json.data.venueName).toBe("The New Room")
    expect(new Date(json.data.startTime).getTime()).toBe(moved.getTime())

    // The people who are going: their own kind in the bell, naming what moved.
    const rows = await db.notifications.findMany({ where: { user_id: { in: [goer, legacyGoer, maybe] } }, select: { user_id: true, kind: true, data: true } })
    const kindOf = (u: string) => rows.find((r) => r.user_id === u)?.kind
    expect(kindOf(goer)).toBe("event_changed")
    expect(kindOf(legacyGoer)).toBe("event_changed")
    expect((rows.find((r) => r.user_id === goer)?.data as { changed?: string }).changed).toBe("time,venue")
    // Everyone else who asked to hear keeps the kind they always had.
    expect(kindOf(maybe)).toBe("event_update")

    // The push: a build that created the new channels gets the new kind; an older build opens the event as it always did.
    const byToken = new Map(sentMessages.map((m) => [m.to, m]))
    expect(byToken.get(`ExponentPushToken[${goer}]`)?.data.type).toBe("event_changed")
    expect(byToken.get(`ExponentPushToken[${goer}]`)?.channelId).toBe("events")
    expect(byToken.get(`ExponentPushToken[${legacyGoer}]`)?.data.type).toBe("event_update")
    expect(byToken.get(`ExponentPushToken[${maybe}]`)?.data.type).toBe("event_update")
  })

  it("a time moved and put back is not a change; a second move is struck from what people were first told", async () => {
    const viewer = await person("scn-v3")
    const id = await event()
    const original = await db.events.findUniqueOrThrow({ where: { id } })
    const at = (h: number) => new Date(original.start_time.getTime() + h * HOUR).toISOString()
    const end = (h: number) => new Date(original.end_time.getTime() + h * HOUR).toISOString()

    await dashboardPatch(id, { start_time: at(1), end_time: end(1) })
    await dashboardPatch(id, { start_time: at(3), end_time: end(3) })
    const twice = await read(viewer, id)
    expect(twice.json.data.changedFields).toEqual(["time"])
    expect(twice.json.data.changedFrom.startTime).toBe(original.start_time.toISOString())

    await dashboardPatch(id, { start_time: at(0), end_time: end(0) })
    const back = await read(viewer, id)
    expect(back.json.data).toMatchObject({ changedAt: null, changedFields: [], changedFrom: null })
  })

  it("a draft records no change: nobody is going to it", async () => {
    const id = await event({ status: "draft" })
    const before = await db.events.findUniqueOrThrow({ where: { id } })
    await dashboardPatch(id, { start_time: new Date(before.start_time.getTime() + HOUR).toISOString(), end_time: before.end_time.toISOString() })
    const row = await db.events.findUniqueOrThrow({ where: { id } })
    expect(row.changed_at).toBeNull()
    expect(row.changed_from).toBeNull()
  })

  it("a cancel from the phone records it, and the going are told", async () => {
    const viewer = await person("scn-v4")
    const id = await event()
    const goer = await going(id, "scn-cgoer", "going", 2)

    const res = await routes.event.PATCH(req(`/api/mobile/events/${id}`, tokenOf(admin), "PATCH", { status: "cancelled" }), eventParams(id))
    expect(res.status).toBe(200)
    // The PATCH response is the shape it was.
    expect(Object.keys((await res.json()).data).sort()).toEqual(["description", "id", "shortDescription", "status", "title"])

    const { json } = await read(viewer, id)
    expect(json.data.changedFields).toEqual(["cancelled"])
    expect(json.data.changedFrom).toBeNull()
    expect(json.data.status).toBe("cancelled")
    const row = await db.notifications.findFirstOrThrow({ where: { user_id: goer }, select: { kind: true, data: true } })
    expect(row.kind).toBe("event_changed")
    expect((row.data as { changed?: string }).changed).toBe("cancelled")
  })
})

describe("recording a change under concurrent edits", () => {
  it("four edits at once, one field each: every one survives in changed_from, and each edit lands", async () => {
    const id = await event()
    const original = await db.events.findUniqueOrThrow({ where: { id } })
    const edits = [
      { start_time: new Date(original.start_time.getTime() + HOUR) },
      { end_time: new Date(original.end_time.getTime() + HOUR) },
      { venue_name: "Elsewhere" },
      { address: "2 Other Rd" },
    ]
    await Promise.all(edits.map((data) => updateEventTracked({ where: { id }, data })))

    const row = await db.events.findUniqueOrThrow({ where: { id } })
    expect(row.changed_from).toEqual({
      start_time: original.start_time.toISOString(),
      end_time: original.end_time.toISOString(),
      venue_name: "The Old Room",
      address: "1 Church St",
    })
    expect(row.changed_at).not.toBeNull()
    expect(row.venue_name).toBe("Elsewhere")
    expect(row.address).toBe("2 Other Rd")
    expect(row.start_time.getTime()).toBe(original.start_time.getTime() + HOUR)
  })

  it("the dashboard PATCH answers with the change it wrote, not the row as it was before", async () => {
    const id = await event()
    const before = await db.events.findUniqueOrThrow({ where: { id } })
    const res = await dashboardEvent.PATCH(
      new Request(`http://localhost/api/events/${id}`, { method: "PATCH", body: JSON.stringify({ venue_name: "Round the corner" }) }),
      { params: Promise.resolve({ id }) }
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.changed_at).not.toBeNull()
    expect(body.changed_from).toEqual({ venue_name: before.venue_name })
  })

  it("an edit and its record stand or fall together: a failing edit leaves no change behind", async () => {
    const id = await event()
    await expect(updateEventTracked({ where: { id }, data: { venue_name: "x", start_time: "not a date" as never } })).rejects.toThrow()
    const row = await db.events.findUniqueOrThrow({ where: { id } })
    expect(row.venue_name).toBe("The Old Room")
    expect(row.changed_at).toBeNull()
  })
})

describe("what the row lock protects", () => {
  it("an edit that arrives while a publish is still open waits for it, so it is recorded against a PUBLISHED event", async () => {
    /*
     * A draft records no change (nobody is going to it). tx1 publishes it and
     * holds. The edit starts meanwhile: without the `SELECT … FOR UPDATE` it
     * reads the row first, still a draft, and only then waits at its UPDATE for
     * tx1, so after tx1 commits it compares against a draft and records nothing.
     * With the lock it waits before it reads, sees the published row, and
     * records the venue change. (Two edits at once do not show this: the UPDATE's
     * own lock and a consistent snapshot make them compute the same union.)
     */
    const id = await event({ status: "draft" })
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let opened!: () => void
    const began = new Promise<void>((r) => (opened = r))
    const publish = db.$transaction(
      async (tx) => {
        await tx.events.update({ where: { id }, data: { status: "published" } })
        opened()
        await held
      },
      { timeout: 30_000 }
    )
    await began

    const edit = updateEventTracked({ where: { id }, data: { venue_name: "Moved mid-publish" } })
    await new Promise((r) => setTimeout(r, 400)) // long enough to have read the row, were it not waiting
    release()
    await publish
    await edit

    const row = await db.events.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe("published")
    expect(row.changed_at).not.toBeNull()
    expect(row.changed_from).toEqual({ venue_name: "The Old Room" })
  })
})

describe("GET /events/:id — the days of a run", () => {
  it("lists every day, a cancelled one marked, and says which day today is", async () => {
    const viewer = await person("scn-v5")
    const id = await event({
      days: [
        { startsInH: -30, endsInH: -27 },
        { startsInH: -6, endsInH: 3 },
        { startsInH: 18, endsInH: 21, cancelled: true },
      ],
    })
    const { json } = await read(viewer, id)

    expect(json.data.dayCount).toBe(3)
    expect(json.data.days.map((d: { cancelled: boolean }) => d.cancelled)).toEqual([false, false, true])
    expect(json.data.days.map((d: { date: string }) => d.date)).toEqual(["2031-01-01", "2031-01-02", "2031-01-03"])
    // Day two is running; day three is called off.
    expect(json.data.dayNumber).toBe(2)
    // The session the app already judges "live" by is untouched.
    expect(json.data.session).toEqual({
      startTime: expect.any(String),
      endTime: expect.any(String),
    })
  })

  it("every day cancelled: no day number", async () => {
    const viewer = await person("scn-v6")
    const id = await event({ days: [{ startsInH: 5, endsInH: 8, cancelled: true }] })
    const { json } = await read(viewer, id)
    expect(json.data.dayNumber).toBeNull()
    expect(json.data.session).toBeNull()
  })
})

describe("GET /events/:id — why a link is refused", () => {
  it("a known age that is too young: AGE_RESTRICTED, said in both fields", async () => {
    const teen = await person("scn-teen", { age: 16 })
    const id = await event({ minAge: 18 })
    const { status, json } = await read(teen, id)
    expect(status).toBe(403)
    expect(json).toMatchObject({ success: false, errorCode: "AGE_RESTRICTED", reasonCode: "AGE_RESTRICTED" })
    expect(json.error).toEqual(expect.any(String))
  })

  it("no age on file: the link opens, and taking part says AGE_UNKNOWN beside the same errorCode", async () => {
    const unknown = await person("scn-noage", { age: null })
    const id = await event({ minAge: 18 })
    // Viewing keeps the posture it had: an OAuth account with no age still sees the page.
    expect((await read(unknown, id)).status).toBe(200)
    const res = await rsvpRoute.POST(req(`/api/mobile/events/${id}/rsvp`, tokenOf(unknown), "POST", { status: "going" }), eventParams(id))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ errorCode: "AGE_RESTRICTED", reasonCode: "AGE_UNKNOWN" })
  })

  it("an unfinished profile taking part: FORBIDDEN, and PROFILE_INCOMPLETE beside it", async () => {
    const unfinished = await person("scn-unfin", { onboarded: false, age: null })
    const id = await event()
    const res = await rsvpRoute.POST(req(`/api/mobile/events/${id}/rsvp`, tokenOf(unfinished), "POST", { status: "going" }), eventParams(id))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ errorCode: "FORBIDDEN", reasonCode: "PROFILE_INCOMPLETE" })
  })

  it("an event hidden because its organisation was suspended says why only to people with a stake in it", async () => {
    const draft = await event({ status: "draft" })
    const plain = { success: false, error: "Event not found", errorCode: "NOT_FOUND" }
    const withReason = { errorCode: "NOT_FOUND", reasonCode: "ORGANISER_SUSPENDED", error: "Event not found" }

    for (const visibility of ["public", "private"] as const) {
      const suspended = await event({ status: "draft", preSuspension: "published", visibility })
      const rsvp = async (label: string, status: "going" | "maybe" | "waitlisted" | "not_going") => {
        const who = await person(label)
        await db.event_rsvps.create({ data: { event_id: suspended, user_id: who, status } })
        return who
      }

      // A stranger: a plain 404, whether the event was public or private.
      const stranger = await read(await person(`scn-sus-stranger-${visibility}`), suspended)
      expect([stranger.status, stranger.json]).toEqual([404, plain])

      // Somebody who said they were coming, in any way but no.
      for (const status of ["going", "maybe", "waitlisted"] as const) {
        const r = await read(await rsvp(`scn-sus-${status}-${visibility}`, status), suspended)
        expect([r.status, r.json]).toEqual([404, expect.objectContaining(withReason)])
      }
      // Somebody who declined is a stranger again.
      const declined = await read(await rsvp(`scn-sus-no-${visibility}`, "not_going"), suspended)
      expect([declined.status, declined.json]).toEqual([404, plain])

      // The organisation that runs it, read from its members: a suspended organisation is out of `actorFor`.
      const staff = await person(`scn-sus-staff-${visibility}`)
      await db.organisation_members.create({ data: { org_id: orgs[0], user_id: staff, role: "staff" } })
      const org = await read(staff, suspended)
      expect([org.status, org.json]).toEqual([404, expect.objectContaining(withReason)])
    }

    // A draft nobody ever published carries no reason for anyone, the people who RSVP'd included.
    const goer = await person("scn-sus-draft-goer")
    await db.event_rsvps.create({ data: { event_id: draft, user_id: goer, status: "going" } })
    const b = await read(goer, draft)
    expect([b.status, b.json]).toEqual([404, plain])
  })
})

describe("every route that refuses a suspended organiser's event says why (SCRUM-749)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crewsRoute = require("@/app/api/mobile/events/[eventId]/crews/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/route")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const previewRoute = require("@/app/api/mobile/events/[eventId]/room-preview/route") as typeof import("@/app/api/mobile/events/[eventId]/room-preview/route")
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const favoriteRoute = require("@/app/api/mobile/events/[eventId]/favorite/route") as typeof import("@/app/api/mobile/events/[eventId]/favorite/route")

  const at = (eventId: string, path: string, who: string, method = "GET", body?: unknown) =>
    req(`/api/mobile/events/${eventId}${path}`, tokenOf(who), method, body)
  const COORDS = { latitude: 12.97, longitude: 77.59 }
  const doors: Record<string, (eventId: string, who: string) => Promise<Response>> = {
    "GET /events/:id": (id, who) => routes.event.GET(at(id, "", who), eventParams(id)),
    "POST /rsvp": (id, who) => rsvpRoute.POST(at(id, "/rsvp", who, "POST", { status: "going" }), eventParams(id)),
    "POST /favorite": (id, who) => favoriteRoute.POST(at(id, "/favorite", who, "POST"), eventParams(id)),
    "GET /board": (id, who) => boardRoute.GET(at(id, "/board", who), eventParams(id)),
    "GET /room-preview": (id, who) => previewRoute.GET(at(id, "/room-preview", who), eventParams(id)),
    "POST /checkin": (id, who) => routes.checkin.POST(at(id, "/checkin", who, "POST", COORDS), eventParams(id)),
    "GET /checkins": (id, who) => routes.roster.GET(at(id, "/checkins", who), eventParams(id)),
    "GET /crews": (id, who) => crewsRoute.GET(at(id, "/crews", who), eventParams(id)),
    "GET /chat": (id, who) => routes.eventChat.GET(at(id, "/chat", who), eventParams(id)),
    "POST /chat": (id, who) => routes.eventChat.POST(at(id, "/chat", who, "POST", { content: "hello" }), eventParams(id)),
  }

  const NOT_FOUND = [404, "NOT_FOUND"]
  const UNCHANGED: Record<string, unknown[]> = {
    "POST /checkin": [400, undefined],
  }
  for (const name of Object.keys(doors)) UNCHANGED[name] ??= NOT_FOUND

  it.each(Object.keys(doors))("%s: reasonCode ORGANISER_SUSPENDED for somebody with a stake, none for a stranger or a draft nobody published", async (name) => {
    const door = doors[name]
    const suspended = await event({ status: "draft", preSuspension: "published" })
    const unpublished = await event({ status: "draft" })
    const label = name.replace(/\W+/g, "")
    const goer = await person(`scn-749-goer-${label}`)
    const stranger = await person(`scn-749-stranger-${label}`)
    const unpublishedGoer = await person(`scn-749-ug-${label}`)
    await db.event_rsvps.create({ data: { event_id: suspended, user_id: goer, status: "going" } })
    await db.event_rsvps.create({ data: { event_id: unpublished, user_id: unpublishedGoer, status: "going" } })

    const told = await door(suspended, goer)
    const toldBody = await told.json()
    expect(toldBody.success).toBe(false)
    expect(toldBody.reasonCode).toBe("ORGANISER_SUSPENDED")
    // The status and errorCode it always had stay: an installed build reads those, and the door's bare 400 never had one.
    expect([told.status, toldBody.errorCode]).toEqual(UNCHANGED[name])

    const strangerBody = await (await door(suspended, stranger)).json()
    expect(strangerBody.success).toBe(false)
    expect(strangerBody).not.toHaveProperty("reasonCode")

    const draftBody = await (await door(unpublished, unpublishedGoer)).json()
    expect(draftBody).not.toHaveProperty("reasonCode")
  })

  it("the same refusal with a chat room that already exists, and for the organisation's own staff", async () => {
    const suspended = await event({ status: "draft", preSuspension: "published" })
    await db.chat_groups.create({ data: { event_id: suspended, name: "Room", status: "active", member_count: 0 } })
    const staff = await person("scn-749-staff")
    await db.organisation_members.create({ data: { org_id: orgs[0], user_id: staff, role: "staff" } })
    // The read says not found; the send, into a room that exists, says the chat is closed.
    for (const [name, status, errorCode] of [["GET /chat", 404, "NOT_FOUND"], ["POST /chat", 403, "FORBIDDEN"]] as const) {
      const res = await doors[name](suspended, staff)
      expect([res.status, await res.json()]).toEqual([status, expect.objectContaining({ errorCode, reasonCode: "ORGANISER_SUSPENDED" })])
    }
  })
})

describe("the whole key set of GET /events/:id", () => {
  // origin/dev's detail, before this branch: every key an installed build may read.
  const OLD_KEYS = [
    "address", "amenities", "categories", "chatGroup", "checkInRadius", "city", "claim", "country", "coverImageUrl", "createdAt",
    "currentCapacity", "description", "details", "distance", "doorPolicy", "endTime", "externalLink", "id", "isFeatured", "isRecurring",
    "latitude", "longitude", "maxCapacity", "media", "minAge", "organizer", "postalCode", "session", "shortDescription", "slug",
    "startTime", "state", "stats", "status", "timezone", "title", "userStatus", "venueName", "visibility",
  ]
  const NEW_KEYS = ["changedAt", "changedFields", "changedFrom", "dayCount", "dayNumber", "days"]

  it("is the old set and exactly the six new ones, nothing renamed or dropped", async () => {
    const viewer = await person("scn-keys")
    const { json } = await read(viewer, await event())
    expect(Object.keys(json.data).sort()).toEqual([...OLD_KEYS, ...NEW_KEYS].sort())
  })
})

describe("one notification when somebody is both going and has saved the event", () => {
  it("a change is told to them once", async () => {
    const id = await event()
    const both = await going(id, "scn-both", "going", 2)
    await db.event_favorites.create({ data: { event_id: id, user_id: both } })
    const before = await db.events.findUniqueOrThrow({ where: { id } })

    await dashboardPatch(id, { venue_name: "Both rooms", start_time: new Date(before.start_time.getTime() + HOUR).toISOString(), end_time: before.end_time.toISOString() })

    expect(await db.notifications.count({ where: { user_id: both } })).toBe(1)
    expect(sentMessages.filter((m) => m.to === `ExponentPushToken[${both}]`)).toHaveLength(1)
  })
})

describe("the token a build registers", () => {
  it("channelSet is stored when sent, and left off when not", async () => {
    const id = await person("scn-tok")
    const route = (await import("@/app/api/mobile/notifications/token/route")) as typeof import("@/app/api/mobile/notifications/token/route")
    const post = (body: object) =>
      route.POST(new NextRequest("http://localhost/api/mobile/notifications/token", { method: "POST", headers: { authorization: `Bearer ${tokenOf(id)}`, "content-type": "application/json" }, body: JSON.stringify(body) }))

    expect((await post({ token: "ExponentPushToken[old]", platform: "android" })).status).toBe(200)
    expect((await post({ token: "ExponentPushToken[new]", platform: "android", channelSet: 2 })).status).toBe(200)
    expect((await post({ token: "ExponentPushToken[bad]", platform: "android", channelSet: 0 })).status).toBe(400)

    const rows = await db.push_tokens.findMany({ where: { user_id: id }, select: { token: true, channel_set: true } })
    expect(Object.fromEntries(rows.map((r) => [r.token, r.channel_set]))).toEqual({
      "ExponentPushToken[old]": null,
      "ExponentPushToken[new]": 2,
    })
  })

  it("the same token re-registered: none then 2 stores 2, and none again leaves it at 2 (an older build must not undo it)", async () => {
    const id = await person("scn-tok2")
    const route = (await import("@/app/api/mobile/notifications/token/route")) as typeof import("@/app/api/mobile/notifications/token/route")
    const post = (body: object) =>
      route.POST(new NextRequest("http://localhost/api/mobile/notifications/token", { method: "POST", headers: { authorization: `Bearer ${tokenOf(id)}`, "content-type": "application/json" }, body: JSON.stringify(body) }))
    const stored = async () => (await db.push_tokens.findFirstOrThrow({ where: { user_id: id, token: "ExponentPushToken[same]" } })).channel_set

    expect((await post({ token: "ExponentPushToken[same]", platform: "android" })).status).toBe(200)
    expect(await stored()).toBeNull()
    expect((await post({ token: "ExponentPushToken[same]", platform: "android", channelSet: 2 })).status).toBe(200)
    expect(await stored()).toBe(2)
    expect((await post({ token: "ExponentPushToken[same]", platform: "android" })).status).toBe(200)
    expect(await stored()).toBe(2)
    expect(await db.push_tokens.count({ where: { user_id: id } })).toBe(1)
  })
})
