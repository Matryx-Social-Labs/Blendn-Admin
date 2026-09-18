import { NextRequest } from "next/server"

/*
 * One event, reached by id, by somebody discovery would not have shown it to.
 *
 * Found by driving sign-up on Android as a 17-year-old against staging
 * (SCRUM-130): the feed hid the 18+ event and the door refused them, and every
 * other single-event route let them in — GET, RSVP, favourite, the board. A
 * draft could be RSVP'd to the same way (SCRUM-13 closed the feed only). This
 * posts the real routes and reads the rows, because the rule now lives in one
 * resolver and the way it regresses is a route that stops calling it.
 *
 * Every 403 is checked by `errorCode`, not status: the board has a 403 of its
 * own ("not going") that a minor with no RSVP would hit anyway, so a bare
 * status would pass with the age guard deleted. The coverage pass proved that
 * by deleting it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/route") as
  typeof import("@/app/api/mobile/events/[eventId]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rsvpRoute = require("@/app/api/mobile/events/[eventId]/rsvp/route") as
  typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoriteRoute = require("@/app/api/mobile/events/[eventId]/favorite/route") as
  typeof import("@/app/api/mobile/events/[eventId]/favorite/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const interestRoute = require("@/app/api/mobile/events/[eventId]/interest/route") as
  typeof import("@/app/api/mobile/events/[eventId]/interest/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as
  typeof import("@/app/api/mobile/events/[eventId]/board/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const boardRequestRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as
  typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const interestedRoute = require("@/app/api/mobile/events/[eventId]/interested-users/route") as
  typeof import("@/app/api/mobile/events/[eventId]/interested-users/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const favoritesListRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as
  typeof import("@/app/api/mobile/users/[userId]/favorites/route")

const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.board_requests.deleteMany({ where: { from_user_id: { in: users } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_favorites.deleteMany({ where: { user_id: { in: users } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function person(
  label: string,
  dateOfBirth: Date | null,
  role: "attendee" | "organizer" = "attendee"
) {
  const id = await makeUser(label, role)
  users.push(id)
  await db.profiles.create({ data: { id, name: `Test ${label}`, date_of_birth: dateOfBirth } })
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const yearsAgo = (n: number) => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - n)
  return d
}

/** An event whose doors have not opened, so its board is open. */
async function futureEvent(host: string, overrides: Parameters<typeof makeEvent>[1] = {}) {
  const id = await makeEvent(host, overrides)
  events.push(id)
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000)
  await db.events.update({
    where: { id },
    data: { start_time: start, end_time: new Date(start.getTime() + 3 * 60 * 60 * 1000) },
  })
  return id
}

const req = (method: "GET" | "POST" | "DELETE", url: string, token: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const params = (eventId: string) => ({ params: Promise.resolve({ eventId }) })
const postParams = (eventId: string, postId: string) => ({ params: Promise.resolve({ eventId, postId }) })

/** `status` and `errorCode` of a response, so a 403 says which 403 it was. */
async function outcome(res: Response) {
  const body = (await res.json()) as { errorCode?: string; error?: string }
  return res.status === 200 || res.status === 201 ? "ok" : `${res.status} ${body.errorCode ?? body.error}`
}

/** Every attendee route that takes one event id, as the given person. */
async function everyRoute(eventId: string, token: string, postId?: string) {
  const base = `/api/mobile/events/${eventId}`
  const results = {
    get: await eventRoute.GET(req("GET", base, token), params(eventId)),
    rsvp: await rsvpRoute.POST(req("POST", `${base}/rsvp`, token, { status: "going" }), params(eventId)),
    favorite: await favoriteRoute.POST(req("POST", `${base}/favorite`, token), params(eventId)),
    interest: await interestRoute.POST(req("POST", `${base}/interest`, token), params(eventId)),
    interested: await interestedRoute.GET(req("GET", `${base}/interested-users`, token), params(eventId)),
    boardGet: await boardRoute.GET(req("GET", `${base}/board`, token), params(eventId)),
    boardPost: await boardRoute.POST(
      req("POST", `${base}/board`, token, { kind: "seeking", body: "anyone going from Indiranagar?" }),
      params(eventId)
    ),
    ...(postId
      ? {
          boardRequest: await boardRequestRoute.POST(
            req("POST", `${base}/board/${postId}/requests`, token, { message: "me" }),
            postParams(eventId, postId)
          ),
        }
      : {}),
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(results)) out[k] = await outcome(v)
  return out
}

const allAge = (withRequest: boolean) =>
  Object.fromEntries(
    ["get", "rsvp", "favorite", "interest", "interested", "boardGet", "boardPost", ...(withRequest ? ["boardRequest"] : [])]
      .map((k) => [k, "403 AGE_RESTRICTED"])
  )
const allNotFound = (withRequest: boolean) =>
  Object.fromEntries(
    ["get", "rsvp", "favorite", "interest", "interested", "boardGet", "boardPost", ...(withRequest ? ["boardRequest"] : [])]
      .map((k) => [k, "404 NOT_FOUND"])
  )

describe("an 18+ event reached by id", () => {
  let eventId: string
  let postId: string

  beforeAll(async () => {
    const host = await makeUser("ea-host", "organizer")
    users.push(host)
    eventId = await futureEvent(host)
    await db.events.update({ where: { id: eventId }, data: { min_age: 18 } })
    // A post on the board by an adult, so the request route has something to ask about.
    const poster = await person("ea-poster", yearsAgo(28))
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: poster.id, status: "going" } })
    const post = await db.board_posts.create({
      data: { event_id: eventId, author_id: poster.id, kind: "seeking", body: "split a cab?" },
    })
    postId = post.id
  })

  it("refuses a 17-year-old on every route with the door's code, and writes nothing", async () => {
    const minor = await person("ea-minor", yearsAgo(17))
    expect(await everyRoute(eventId, minor.token, postId)).toEqual(allAge(true))

    const get = await eventRoute.GET(req("GET", `/api/mobile/events/${eventId}`, minor.token), params(eventId))
    expect(await get.json()).toMatchObject({ errorCode: "AGE_RESTRICTED", error: "This event is 18+." })

    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
    expect(await db.event_favorites.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
    expect(await db.board_requests.count({ where: { from_user_id: minor.id } })).toBe(0)
  })

  it("lets a 30-year-old in (negative control for the rule)", async () => {
    const adult = await person("ea-adult", yearsAgo(30))
    const r = await everyRoute(eventId, adult.token)
    expect([r.get, r.rsvp, r.favorite, r.interested, r.boardGet]).toEqual(["ok", "ok", "ok", "ok", "ok"])
    // `interest` toggles the favourite the previous call made; the board post
    // fails its own profile gate (two interests, an intent) — not the age one.
    expect(r.interest).toBe("ok")
    expect(r.boardPost).toBe("403 FORBIDDEN")
    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: adult.id } })).toBe(1)
  })

  it("shows an account with no age the event and refuses it a seat — discovery's posture, then the door's", async () => {
    const unknown = await person("ea-unknown", null)
    const r = await everyRoute(eventId, unknown.token, postId)
    expect(r.get).toBe("ok")
    expect(r.interested).toBe("ok")
    expect([r.rsvp, r.favorite, r.interest, r.boardGet, r.boardPost, r.boardRequest]).toEqual(
      Array(6).fill("403 AGE_RESTRICTED")
    )
  })

  it("lets someone who got in before the rule withdraw, and never refuses a withdrawal on age", async () => {
    const minor = await person("ea-minor-leaving", yearsAgo(17))
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: minor.id, status: "going" } })
    await db.event_favorites.create({ data: { event_id: eventId, user_id: minor.id } })

    const rsvp = await rsvpRoute.DELETE(req("DELETE", `/api/mobile/events/${eventId}/rsvp`, minor.token), params(eventId))
    const fav = await favoriteRoute.DELETE(req("DELETE", `/api/mobile/events/${eventId}/favorite`, minor.token), params(eventId))
    expect([rsvp.status, fav.status]).toEqual([200, 200])
    expect(await db.event_rsvps.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
    expect(await db.event_favorites.count({ where: { event_id: eventId, user_id: minor.id } })).toBe(0)
  })

  it("is open to everyone once the restriction is lifted (negative control for the guard)", async () => {
    await db.events.update({ where: { id: eventId }, data: { min_age: null } })
    const minor = await person("ea-minor-2", yearsAgo(17))
    const r = await everyRoute(eventId, minor.token)
    expect([r.get, r.rsvp, r.favorite]).toEqual(["ok", "ok", "ok"])
  })
})

describe("events discovery would never list", () => {
  it("a draft reads as not found on every route, including withdrawals, so an id is not a way to learn it exists", async () => {
    const host = await makeUser("ea-draft-host", "organizer")
    users.push(host)
    const draft = await futureEvent(host)
    await db.events.update({ where: { id: draft }, data: { status: "draft" } })
    const someone = await person("ea-someone", yearsAgo(30))

    expect(await everyRoute(draft, someone.token, "00000000-0000-0000-0000-000000000000")).toEqual(allNotFound(true))
    // The same body a genuinely missing event gets — nothing to tell them apart by.
    const get = await eventRoute.GET(req("GET", `/api/mobile/events/${draft}`, someone.token), params(draft))
    expect(await get.json()).toEqual({ success: false, error: "Event not found", errorCode: "NOT_FOUND" })
    const rsvpDelete = await rsvpRoute.DELETE(req("DELETE", `/api/mobile/events/${draft}/rsvp`, someone.token), params(draft))
    expect(await outcome(rsvpDelete)).toBe("404 NOT_FOUND")
    expect(await db.event_rsvps.count({ where: { event_id: draft } })).toBe(0)
  })

  it("a soft-deleted event is not found", async () => {
    const host = await makeUser("ea-deleted-host", "organizer")
    users.push(host)
    const gone = await futureEvent(host, { deleted_at: new Date() })
    const someone = await person("ea-someone-2", yearsAgo(30))
    expect((await everyRoute(gone, someone.token)).get).toBe("404 NOT_FOUND")
  })

  it("a cancelled event is still reachable — people were told, and the page should say so", async () => {
    const host = await makeUser("ea-cancelled-host", "organizer")
    users.push(host)
    const cancelled = await futureEvent(host)
    await db.events.update({ where: { id: cancelled }, data: { status: "cancelled" } })
    const someone = await person("ea-someone-3", yearsAgo(30))
    expect((await everyRoute(cancelled, someone.token)).get).toBe("ok")
  })

  it("a private event is not found for a stranger, open to a guest, and open to a colleague at the organisation", async () => {
    const org = await db.organisations.create({ data: { display_name: `EA Org ${testId("o")}` } })
    orgs.push(org.id)
    const creator = await makeUser("ea-private-host", "organizer")
    users.push(creator)
    const priv = await futureEvent(creator, { visibility: "private" })
    await db.events.update({ where: { id: priv }, data: { organizer_org_id: org.id } })

    const stranger = await person("ea-stranger", yearsAgo(30))
    const guest = await person("ea-guest", yearsAgo(30))
    await db.event_rsvps.create({ data: { event_id: priv, user_id: guest.id, status: "maybe" } })
    // Not the creator — a colleague, entitled through membership alone.
    const colleague = await person("ea-colleague", yearsAgo(35), "organizer")
    await db.organisation_members.create({ data: { org_id: org.id, user_id: colleague.id, role: "staff" } })
    const otherOrganiser = await person("ea-other-organiser", yearsAgo(35), "organizer")

    expect((await everyRoute(priv, stranger.token)).get).toBe("404 NOT_FOUND")
    expect((await everyRoute(priv, otherOrganiser.token)).get).toBe("404 NOT_FOUND")
    expect((await everyRoute(priv, guest.token)).get).toBe("ok")
    expect((await everyRoute(priv, colleague.token)).get).toBe("ok")
  })
})

/*
 * A save whose event went dark after the save (SCRUM-176).
 *
 * Found driving SCRUM-149: an organiser set a saved event to draft — the flip
 * an organisation's suspension makes on every published event (SCRUM-8) —
 * and the saved list still returned it, the event page 404'd, and DELETE
 * /favorite 404'd through the same door. A card that could be neither opened
 * nor dismissed. Cancelled is different: history, listed, labelled by `status`.
 */
describe("a saved event that went dark", () => {
  const saved = (userId: string, token: string) =>
    favoritesListRoute
      .GET(req("GET", `/api/mobile/users/${userId}/favorites`, token), { params: Promise.resolve({ userId }) })
      .then((r) => r.json())
      .then((j: { data: { events: Array<{ id: string; status: string }> } }) => j.data.events)

  it("drops a draft from the saved list and still lets the save be removed", async () => {
    const host = await makeUser("ea-dark-host", "organizer")
    users.push(host)
    const fan = await person("ea-fan", yearsAgo(30))
    const live = await futureEvent(host)
    const going = await futureEvent(host)
    await db.event_favorites.createMany({
      data: [live, going].map((event_id) => ({ event_id, user_id: fan.id })),
    })
    expect((await saved(fan.id, fan.token)).map((e) => e.id).sort()).toEqual([live, going].sort())

    await db.events.update({ where: { id: going }, data: { status: "draft" } })
    expect((await saved(fan.id, fan.token)).map((e) => e.id)).toEqual([live])

    // The door still says "not found" for the draft itself — that is right.
    const get = await eventRoute.GET(req("GET", `/api/mobile/events/${going}`, fan.token), params(going))
    expect(get.status).toBe(404)

    // But a removal is never refused, and it tells the stranger nothing.
    const del = await favoriteRoute.DELETE(req("DELETE", `/api/mobile/events/${going}/favorite`, fan.token), params(going))
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ data: { isFavorited: false, favoriteCount: 0 } })
    expect(await db.event_favorites.count({ where: { event_id: going, user_id: fan.id } })).toBe(0)
  })

  it("keeps a cancelled one, and says so on the row (negative control for the draft rule)", async () => {
    const host = await makeUser("ea-cancel-host", "organizer")
    users.push(host)
    const fan = await person("ea-fan-2", yearsAgo(30))
    const event = await futureEvent(host)
    await db.event_favorites.create({ data: { event_id: event, user_id: fan.id } })
    await db.events.update({ where: { id: event }, data: { status: "cancelled" } })
    expect(await saved(fan.id, fan.token)).toMatchObject([{ id: event, status: "cancelled" }])
  })
})
