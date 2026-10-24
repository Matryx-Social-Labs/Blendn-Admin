/**
 * The Going lists, paged by keyset beside the page numbers installed builds
 * use: `/me/rsvps`, `/users/:id/favorites`, `/me/attendance`, `/friends?q=`
 * and the invites on `/crews`; plus `ratedAt` and `venue_type` on attendance
 * and the reasons on the rating refusals. Real handlers, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"
import { conversationPair } from "@/lib/conversations"
import { friendNameWhere, matches } from "@/lib/friends-here"
import { cleanupWorld, person, routes, venue, world } from "./go-live-world"
import { closeDb, db, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const rsvpsRoute = require("@/app/api/mobile/me/rsvps/route") as typeof import("@/app/api/mobile/me/rsvps/route")
const favoritesRoute = require("@/app/api/mobile/users/[userId]/favorites/route") as typeof import("@/app/api/mobile/users/[userId]/favorites/route")
const friendsRoute = require("@/app/api/mobile/friends/route") as typeof import("@/app/api/mobile/friends/route")
const crewsRoute = require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route")
const ratingRoute = require("@/app/api/mobile/events/[eventId]/rating/route") as typeof import("@/app/api/mobile/events/[eventId]/rating/route")
const peerRoute = require("@/app/api/mobile/events/[eventId]/peer-ratings/route") as typeof import("@/app/api/mobile/events/[eventId]/peer-ratings/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 3_600_000
const events: string[] = []
const crewIds: string[] = []

afterAll(async () => {
  delete process.env.PLUS_GATING
  await db.event_ratings.deleteMany({ where: { event_id: { in: events } } })
  await db.peer_ratings.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crewIds } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crewIds } } })
  await db.crews.deleteMany({ where: { id: { in: crewIds } } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: world.users } }, { user2_id: { in: world.users } }] } })
  await cleanupWorld()
  await closeDb()
})

type Me = { id: string; token: string }

/** An onboarded adult whose card says `name`. */
async function named(label: string, name: string) {
  const p = await person(label)
  await db.profiles.update({ where: { id: p.id }, data: { name } })
  return p
}

async function eventAt(owner: string, startsInH: number, extra: { city?: string; endsInH?: number } = {}) {
  const start = new Date(Date.now() + startsInH * HOUR)
  const row = await db.events.create({
    data: {
      slug: testId("gp"),
      title: `Night ${testId("t")}`,
      description: "integration fixture",
      start_time: start,
      end_time: new Date(Date.now() + (extra.endsInH ?? startsInH + 3) * HOUR),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: owner,
      city: extra.city ?? "Bengaluru",
    },
  })
  events.push(row.id)
  return row
}

const get = (route: { GET: (r: NextRequest, c: never) => Promise<Response> }, path: string, me: Me, ctx: unknown = {}) =>
  route.GET(new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${me.token}` } }), ctx as never)

/** Every page of a cursor walk, until `nextCursor` is null. */
async function walk(path: (cursor: string | null) => Promise<{ status: number; json: any }>, pick: (data: any) => string[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const seen: string[] = []
  const sizes: number[] = []
  let cursor: string | null = null
  for (let i = 0; i < 20; i++) {
    const { status, json } = await path(cursor)
    expect(status).toBe(200)
    const ids = pick(json.data)
    seen.push(...ids)
    sizes.push(ids.length)
    cursor = json.data.pagination.nextCursor
    if (!cursor) break
  }
  return { seen, sizes }
}
const body = async (res: Response) => ({ status: res.status, json: await res.json() })

describe("GET /me/rsvps and /users/:id/favorites: cursor beside page", () => {
  let me: Me
  let order: string[] = []

  beforeAll(async () => {
    me = await person("gp_me")
    const host = await person("gp_host")
    const same = Date.now() + 40 * HOUR
    const rows = []
    // Two share a start time to the millisecond: the id breaks the tie.
    for (const h of [30, 31, 32, 34]) rows.push(await eventAt(host.id, h))
    for (let i = 0; i < 2; i++) {
      const e = await eventAt(host.id, 40)
      await db.events.update({ where: { id: e.id }, data: { start_time: new Date(same), end_time: new Date(same + 3 * HOUR) } })
      rows.push(e)
    }
    for (const e of rows) {
      await db.event_rsvps.create({ data: { event_id: e.id, user_id: me.id, status: "going" } })
      await db.event_favorites.create({ data: { event_id: e.id, user_id: me.id } })
    }
    const read = await body(await get(rsvpsRoute, "/api/mobile/me/rsvps?limit=100", me))
    order = read.json.data.events.map((e: { id: string }) => e.id)
  })

  it("rsvps: a cursor walk lists every event once, in the page route's order, with the total on every page", async () => {
    expect(order).toHaveLength(6)
    const pages: number[] = []
    const { seen, sizes } = await walk(
      async (c) => {
        const r = await body(await get(rsvpsRoute, `/api/mobile/me/rsvps?limit=4${c ? `&cursor=${c}` : ""}`, me))
        pages.push(r.json.data.pagination.totalCount)
        return r
      },
      (d) => d.events.map((e: { id: string }) => e.id)
    )
    expect(seen).toEqual(order)
    expect(sizes).toEqual([4, 2])
    expect(pages).toEqual([6, 6])
  })

  it("rsvps: ?page= still answers as it did, and adds nextCursor", async () => {
    const r = await body(await get(rsvpsRoute, "/api/mobile/me/rsvps?page=2&limit=4", me))
    expect(r.json.data.events.map((e: { id: string }) => e.id)).toEqual(order.slice(4))
    expect(r.json.data.pagination).toMatchObject({ page: 2, limit: 4, totalCount: 6, totalPages: 2, hasMore: false, nextCursor: null })
    const first = await body(await get(rsvpsRoute, "/api/mobile/me/rsvps?limit=4", me))
    expect(first.json.data.pagination).toMatchObject({ page: 1, hasMore: true })
    expect(typeof first.json.data.pagination.nextCursor).toBe("string")
  })

  it("rsvps: neither page, limit nor cursor is a build that cannot page, and gets the list", async () => {
    const r = await body(await get(rsvpsRoute, "/api/mobile/me/rsvps", me))
    expect(r.json.data.events).toHaveLength(6)
  })

  it("a cursor that is not ours is a 400, never a wide read (all three lists)", async () => {
    const notUuid = Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: "x'; drop" })).toString("base64url")
    const noTime = Buffer.from(JSON.stringify({ t: null, id: "00000000-0000-4000-8000-000000000000" })).toString("base64url")
    for (const cursor of ["garbage", notUuid, noTime]) {
      expect((await get(rsvpsRoute, `/api/mobile/me/rsvps?cursor=${cursor}`, me)).status).toBe(400)
      expect((await get(favoritesRoute, `/api/mobile/users/${me.id}/favorites?cursor=${cursor}`, me, { params: Promise.resolve({ userId: me.id }) })).status).toBe(400)
      expect((await get(routes.attendance, `/api/mobile/me/attendance?cursor=${cursor}`, me)).status).toBe(400)
    }
  })

  it("favorites: no params is a build that cannot page, and is answered up to 200", async () => {
    const r = await body(await get(favoritesRoute, `/api/mobile/users/${me.id}/favorites`, me, { params: Promise.resolve({ userId: me.id }) }))
    expect(r.json.data.pagination.limit).toBe(200)
    expect(r.json.data.events).toHaveLength(6)
  })

  it("favorites: the same walk, newest saved first, nothing repeated or lost", async () => {
    const ctx = { params: Promise.resolve({ userId: me.id }) }
    const all = await body(await get(favoritesRoute, `/api/mobile/users/${me.id}/favorites?limit=100`, me, ctx))
    const expected = all.json.data.events.map((e: { id: string }) => e.id)
    expect(expected).toHaveLength(6)
    const { seen, sizes } = await walk(
      async (c) => body(await get(favoritesRoute, `/api/mobile/users/${me.id}/favorites?limit=4${c ? `&cursor=${c}` : ""}`, me, ctx)),
      (d) => d.events.map((e: { id: string }) => e.id)
    )
    expect(seen).toEqual(expected)
    expect(sizes).toEqual([4, 2])
    const page2 = await body(await get(favoritesRoute, `/api/mobile/users/${me.id}/favorites?page=2&limit=4`, me, ctx))
    expect(page2.json.data.events.map((e: { id: string }) => e.id)).toEqual(expected.slice(4))
    expect(page2.json.data.pagination).toMatchObject({ page: 2, totalCount: 6, hasMore: false, nextCursor: null })
  })
})

describe("GET /me/attendance: cursor, ratedAt, venue_type", () => {
  let me: Me
  let ids: string[] = []
  let rated = ""
  let dayId = ""
  let venueId = ""

  beforeAll(async () => {
    me = await person("gp_att")
    const host = await person("gp_att_host")
    // Five ended nights, two sharing a first check-in instant, all in the gated city.
    const base = Date.now() - 100 * 24 * HOUR
    for (let i = 0; i < 5; i++) {
      const start = new Date(base + (i === 4 ? 3 : i) * 24 * HOUR)
      const e = await eventAt(host.id, 0, { endsInH: -1 })
      await db.events.update({ where: { id: e.id }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) } })
      const occ = await db.event_occurrences.create({
        data: { event_id: e.id, occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) },
      })
      await db.event_check_ins.create({
        data: { event_id: e.id, occurrence_id: occ.id, user_id: me.id, kind: "attendee", status: "checked_out", check_in_time: start },
      })
      if (i === 1) {
        rated = e.id
        await db.event_ratings.create({ data: { event_id: e.id, user_id: me.id, rating: 4 } })
      }
    }
    venueId = await venue()
    await db.venues.update({ where: { id: venueId }, data: { venue_type: "cafe" } })
    const { venueDayFor } = await import("@/lib/venue-day")
    const day = await venueDayFor(venueId)
    if (!day) throw new Error("no venue day")
    dayId = day.id
    await db.event_check_ins.create({
      data: { event_id: day.id, occurrence_id: day.occurrenceId, user_id: me.id, kind: "attendee", status: "checked_out", check_in_time: new Date(Date.now() - 2 * HOUR) },
    })
    const all = await body(await get(routes.attendance, "/api/mobile/me/attendance?limit=100", me))
    ids = all.json.data.events.map((e: { id: string }) => e.id)
  })

  afterAll(async () => {
    await db.event_check_ins.deleteMany({ where: { event_id: dayId } })
  })

  it("a cursor walk lists each night once, newest first, equal to the page route's list", async () => {
    expect(ids).toHaveLength(6)
    expect(ids[0]).toBe(dayId)
    const { seen, sizes } = await walk(
      async (c) => body(await get(routes.attendance, `/api/mobile/me/attendance?limit=4${c ? `&cursor=${c}` : ""}`, me)),
      (d) => d.events.map((e: { id: string }) => e.id)
    )
    expect(seen).toEqual(ids)
    expect(sizes).toEqual([4, 2])
    const p2 = await body(await get(routes.attendance, "/api/mobile/me/attendance?page=2&limit=4", me))
    expect(p2.json.data.events.map((e: { id: string }) => e.id)).toEqual(ids.slice(4))
    expect(p2.json.data.pagination).toMatchObject({ page: 2, totalCount: 6, nextCursor: null })
  })

  it("where Plus gates, the cursor pages the free nights and stops at them", async () => {
    process.env.PLUS_GATING = "Bengaluru"
    try {
      // Today's venue day is still running: listed, and not one of the 3 free ended slots (S-1).
      const locked = await body(await get(routes.attendance, "/api/mobile/me/attendance?limit=2", me))
      expect(locked.json.data.lockedCount).toBe(2)
      expect(locked.json.data.pagination).toMatchObject({ totalCount: 4, hasMore: true })
      const { seen, sizes } = await walk(
        async (c) => body(await get(routes.attendance, `/api/mobile/me/attendance?limit=2${c ? `&cursor=${c}` : ""}`, me)),
        (d) => d.events.map((e: { id: string }) => e.id)
      )
      expect(seen).toEqual(ids.slice(0, 4))
      expect(sizes).toEqual([2, 2])
    } finally {
      delete process.env.PLUS_GATING
    }
  })

  it("ratedAt is when you rated that night (null otherwise, and for a place); venue_type is the place's", async () => {
    const rows = (await body(await get(routes.attendance, "/api/mobile/me/attendance?limit=100", me))).json.data.events as {
      id: string; kind: string; ratedAt: string | null; venue_type: string | null
    }[]
    const stored = await db.event_ratings.findFirstOrThrow({ where: { event_id: rated, user_id: me.id }, select: { updated_at: true } })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(rated)?.ratedAt).toBe(stored.updated_at.toISOString())
    expect(rows.filter((r) => r.kind === "event" && r.id !== rated).every((r) => r.ratedAt === null)).toBe(true)
    expect(byId.get(dayId)).toMatchObject({ kind: "venue_day", ratedAt: null, venue_type: "cafe" })
    expect(rows.filter((r) => r.kind === "event").every((r) => r.venue_type === null)).toBe(true)
  })

  it("ratedAt is the caller's own: another person's rating of the same night is not shown", async () => {
    const other = await person("gp_att_other")
    await db.event_ratings.create({ data: { event_id: ids[ids.length - 1], user_id: other.id, rating: 5 } })
    const rows = (await body(await get(routes.attendance, "/api/mobile/me/attendance?limit=100", me))).json.data.events as { id: string; ratedAt: string | null }[]
    expect(rows.find((r) => r.id === ids[ids.length - 1])?.ratedAt).toBeNull()
  })
})

describe("GET /friends?q=", () => {
  let me: Me
  const names = ["Asha Rao", "Priya Natarajan", "Rohan Rao", "Anaya Khan", "Sam Raoul"]
  const friendIds: Record<string, string> = {}

  beforeAll(async () => {
    me = await named("gp_fr_me", "Me Myself")
    for (const name of names) {
      const f = await named("gp_fr", name)
      friendIds[name] = f.id
      const [user1_id, user2_id] = conversationPair(me.id, f.id)
      await db.friendships.create({ data: { user1_id, user2_id } })
    }
    // No profile name: the account's name is what the card shows, so it is what q reads.
    const bare = await person("gp_fr_bare")
    await db.profiles.update({ where: { id: bare.id }, data: { name: "" } })
    await db.user.update({ where: { id: bare.id }, data: { name: "Zed Raoman" } })
    friendIds["Zed Raoman"] = bare.id
    const [user1_id, user2_id] = conversationPair(me.id, bare.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
  })

  const listed = async (qs: string) => {
    const r = await body(await get(friendsRoute, `/api/mobile/friends${qs}`, me))
    return { status: r.status, names: (r.json.data?.friends ?? []).map((f: { name: string }) => f.name), data: r.json.data }
  }

  it("keeps friends a word of whose name starts with q, any case, and the total is the filtered one", async () => {
    const r = await listed("?q=RAO")
    expect(r.names.sort()).toEqual(["Asha Rao", "Rohan Rao", "Sam Raoul", "Zed Raoman"])
    expect(r.data.count).toBe(4)
    expect(r.data.pagination.totalCount).toBe(4)
    expect((await listed("?q=ao")).names).toEqual([])
    expect((await listed("?q=%20na")).names).toEqual(["Priya Natarajan"])
    // LIKE wildcards are letters: "%" and "_" match nothing here, and "r_o" is not "rao".
    expect((await listed("?q=%25")).names).toEqual([])
    expect((await listed("?q=r_o")).names).toEqual([])
    expect((await listed("")).data.pagination.totalCount).toBe(6)
  })

  it("agrees with the Room's friend search on who matches", async () => {
    for (const q of ["rao", "na", "a", "khan", "r"]) {
      const expected = [...names, "Zed Raoman"].filter((n) => matches(n, q)).sort()
      expect((await listed(`?q=${q}`)).names.sort()).toEqual(expected)
    }
    expect(JSON.stringify(friendNameWhere("rao"))).toContain("insensitive")
  })

  it("combines with limit and cursor: a walk of the filtered list repeats and loses nobody", async () => {
    const { seen, sizes } = await walk(
      async (c) => body(await get(friendsRoute, `/api/mobile/friends?q=rao&limit=3${c ? `&cursor=${c}` : ""}`, me)),
      (d) => d.friends.map((f: { name: string }) => f.name)
    )
    expect(seen.sort()).toEqual(["Asha Rao", "Rohan Rao", "Sam Raoul", "Zed Raoman"])
    expect(sizes).toEqual([3, 1])
  })

  it("refuses a search past 40 characters, and a blank one is no filter", async () => {
    expect((await listed(`?q=${"a".repeat(41)}`)).status).toBe(400)
    expect((await listed(`?q=${"a".repeat(40)}`)).status).toBe(200)
    expect((await listed("?q=%20%20")).data.pagination.totalCount).toBe(6)
  })
})

describe("GET /crews: invites, capped and paged", () => {
  let me: Me
  
  beforeAll(async () => {
    me = await person("gp_cr_me")
    const owner = await person("gp_cr_owner")
    for (const p of [me.id]) {
      const [user1_id, user2_id] = conversationPair(owner.id, p)
      await db.friendships.create({ data: { user1_id, user2_id } })
    }
    const start = Date.now() - 10 * HOUR
    for (let i = 0; i < 5; i++) {
      const crew = await db.crews.create({
        data: { name: `Crew ${i} ${testId("c")}`.slice(0, 32), emblem_seed: `s${i}`, created_by: owner.id },
      })
      crewIds.push(crew.id)
      await db.crew_members.create({ data: { crew_id: crew.id, user_id: owner.id, role: "owner", consented_reveal_at: new Date() } })
      // Two share a created_at: the id breaks the tie.
      await db.crew_invites.create({
        data: { crew_id: crew.id, invited_user_id: me.id, invited_by: owner.id, created_at: new Date(start + (i === 4 ? 3 : i) * 60_000) },
      })
          }
  })

  const pageOf = async (qs: string) => body(await get(crewsRoute, `/api/mobile/crews${qs}`, me))

  it("answers an installed build with the invites and a total, and pages a client that asks", async () => {
    const all = await pageOf("")
    const ids = all.json.data.invites.map((i: { crewId: string }) => i.crewId)
    expect(ids).toHaveLength(5)
    expect(all.json.data.invitesPagination).toMatchObject({ limit: 200, hasMore: false, nextCursor: null, totalCount: 5 })
    expect(Object.keys(all.json.data)).toEqual(expect.arrayContaining(["crews", "invites"]))

    const { seen, sizes } = await walk(
      async (c) => pageOf(`?limit=2${c ? `&cursor=${c}` : ""}`).then((r) => ({ status: r.status, json: { data: { ...r.json.data, pagination: r.json.data.invitesPagination } } })),
      (d) => d.invites.map((i: { crewId: string }) => i.crewId)
    )
    expect(seen).toEqual(ids)
    expect(sizes).toEqual([2, 2, 1])
    expect((await pageOf("?cursor=garbage")).status).toBe(400)
    // A well-formed cursor with no time is not one of ours either.
    const noTime = Buffer.from(JSON.stringify({ t: null, id: "00000000-0000-4000-8000-000000000000" })).toString("base64url")
    expect((await pageOf(`?cursor=${noTime}`)).status).toBe(400)
  })

  it("201 open invites: the read is capped at 200, and the last page says it is the last", async () => {
    const lots = await person("gp_cr_lots")
    const owner = await person("gp_cr_lotsowner")
    const [user1_id, user2_id] = conversationPair(owner.id, lots.id)
    await db.friendships.create({ data: { user1_id, user2_id } })
    const crews = await Promise.all(
      Array.from({ length: 201 }, (_, i) =>
        db.crews.create({ data: { name: `Lots ${i}`, emblem_seed: `l${i}`, created_by: owner.id } })
      )
    )
    crewIds.push(...crews.map((c) => c.id))
    await db.crew_members.createMany({
      data: crews.map((c) => ({ crew_id: c.id, user_id: owner.id, role: "owner" as const, consented_reveal_at: new Date() })),
    })
    const base = Date.now() - 5 * HOUR
    await db.crew_invites.createMany({
      data: crews.map((c, i) => ({ crew_id: c.id, invited_user_id: lots.id, invited_by: owner.id, created_at: new Date(base + i * 1000) })),
    })
    const seen: string[] = []
    let last: { hasMore: boolean; totalCount: number } | null = null
    let cursor: string | null = null
    for (let i = 0; i < 10; i++) {
      const r = await body(await get(crewsRoute, `/api/mobile/crews?limit=100${cursor ? `&cursor=${cursor}` : ""}`, lots))
      seen.push(...r.json.data.invites.map((x: { crewId: string }) => x.crewId))
      last = r.json.data.invitesPagination
      expect(last!.totalCount).toBeLessThanOrEqual(200)
      cursor = r.json.data.invitesPagination.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(200)
    expect(new Set(seen).size).toBe(200)
    expect(last).toMatchObject({ hasMore: false, totalCount: 200 })
  })
})

describe("rating refusals carry a reasonCode, and keep their errorCode", () => {
  it("event rating: NOT_ATTENDED without a check-in, NOT_ENDED before it is over", async () => {
    const me = await person("gp_rt_me")
    const host = await person("gp_rt_host")
    const stranger = await person("gp_rt_stranger")
    const ongoing = await eventAt(host.id, -1, { endsInH: 2 })
    const occ = await db.event_occurrences.create({
      data: { event_id: ongoing.id, occurs_on: new Date(), start_time: ongoing.start_time, end_time: ongoing.end_time },
    })
    await db.event_check_ins.create({
      data: { event_id: ongoing.id, occurrence_id: occ.id, user_id: me.id, kind: "attendee", status: "checked_in", check_in_time: new Date() },
    })
    const rate = (who: Me) =>
      ratingRoute.POST(
        new NextRequest(`http://localhost/api/mobile/events/${ongoing.id}/rating`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${who.token}` },
          body: JSON.stringify({ rating: 5 }),
        }),
        { params: Promise.resolve({ eventId: ongoing.id }) }
      )
    const notAttended = await body(await rate(stranger))
    expect([notAttended.status, notAttended.json.errorCode, notAttended.json.reasonCode]).toEqual([403, "FORBIDDEN", "NOT_ATTENDED"])
    const notEnded = await body(await rate(me))
    expect([notEnded.status, notEnded.json.errorCode, notEnded.json.reasonCode]).toEqual([403, "FORBIDDEN", "NOT_ENDED"])
  })

  it("peer rating: NOT_ENDED while the night runs, NOT_CONNECTED once it is over and you did not connect", async () => {
    const me = await person("gp_pr_me")
    const them = await person("gp_pr_them")
    const host = await person("gp_pr_host")
    const running = await eventAt(host.id, -1, { endsInH: 2 })
    const over = await eventAt(host.id, -5, { endsInH: -2 })
    const rate = (eventId: string) =>
      peerRoute.POST(
        new NextRequest(`http://localhost/api/mobile/events/${eventId}/peer-ratings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${me.token}` },
          body: JSON.stringify({ userId: them.id, rating: 4 }),
        }),
        { params: Promise.resolve({ eventId }) }
      )
    const early = await body(await rate(running.id))
    expect([early.status, early.json.errorCode, early.json.reasonCode]).toEqual([403, "FORBIDDEN", "NOT_ENDED"])
    const late = await body(await rate(over.id))
    expect([late.status, late.json.errorCode, late.json.reasonCode]).toEqual([403, "FORBIDDEN", "NOT_CONNECTED"])
  })
})

describe("categories on /me/rsvps and /me/attendance rows, as favourites sends them", () => {
  it("each row carries its event's categories; an event with none carries []", async () => {
    const me = await person("gp_cat_me")
    const host = await person("gp_cat_host")
    const category = await db.categories.create({ data: { name: "Live music", slug: testId("gp-live-music"), icon: "music-2" } })
    const upcoming = await eventAt(host.id, 24)
    const bare = await eventAt(host.id, 30)
    const past = await eventAt(host.id, -6, { endsInH: -3 })
    try {
      await db.event_categories.createMany({ data: [upcoming, past].map((e) => ({ event_id: e.id, category_id: category.id })) })
      for (const e of [upcoming, bare]) await db.event_rsvps.create({ data: { event_id: e.id, user_id: me.id, status: "going" } })
      const occ = await db.event_occurrences.create({ data: { event_id: past.id, occurs_on: new Date(past.start_time.toISOString().slice(0, 10)), start_time: past.start_time, end_time: past.end_time } })
      await db.event_check_ins.create({ data: { event_id: past.id, occurrence_id: occ.id, user_id: me.id, kind: "attendee", status: "checked_out", check_in_time: past.start_time } })

      const shape = { id: category.id, name: "Live music", slug: category.slug, icon: "music-2" }
      const rsvps = (await body(await get(rsvpsRoute, "/api/mobile/me/rsvps?limit=50", me))).json.data.events as { id: string; categories: unknown[] }[]
      expect(rsvps.find((e) => e.id === upcoming.id)?.categories).toEqual([shape])
      expect(rsvps.find((e) => e.id === bare.id)?.categories).toEqual([])
      const nights = (await body(await get(routes.attendance, "/api/mobile/me/attendance?limit=50", me))).json.data.events as { id: string; categories: unknown[] }[]
      expect(nights.find((e) => e.id === past.id)?.categories).toEqual([shape])
    } finally {
      await db.event_categories.deleteMany({ where: { category_id: category.id } })
      await db.event_check_ins.deleteMany({ where: { event_id: past.id } })
      await db.event_rsvps.deleteMany({ where: { event_id: { in: [upcoming.id, bare.id] } } })
      await db.categories.delete({ where: { id: category.id } })
    }
  })
})
